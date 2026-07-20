// Synthesizes audio for sprint_sentences rows that don't have one yet (audio_path IS
// NULL), using macOS `say` (voice Kyoko, reading straight from kana to avoid kanji
// misreadings) piped through ffmpeg to mp3. Writes files to public/sprint/<id>.mp3 and
// batches the audio_path UPDATEs.
//
// Usage: npm run sprint:tts -- [--chunk N] [--force]
//   (node --env-file=.env.local scripts/tts-sprint.mjs)
import { neon } from "@neondatabase/serverless";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- CLI flags ---
function parseArgs(argv) {
  const args = { chunk: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chunk") args.chunk = parseInt(argv[++i], 10);
    else if (a === "--force") args.force = true;
  }
  if (args.chunk != null && !Number.isFinite(args.chunk)) args.chunk = null;
  return args;
}
const args = parseArgs(process.argv.slice(2));

// --- Make sure both external tools exist before doing any work ---
function requireTool(cmd, hint) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
  } catch {
    console.error(`Required tool "${cmd}" was not found on PATH. ${hint}`);
    process.exit(1);
  }
}
requireTool("say", "This script requires macOS's `say` command (voice Kyoko) for text-to-speech.");
requireTool("ffmpeg", "Install ffmpeg (e.g. `brew install ffmpeg`) to convert audio to mp3.");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(url);

// --- Load rows needing audio ---
const where = [];
const params = [];
if (!args.force) where.push("audio_path IS NULL");
if (args.chunk != null) {
  params.push(args.chunk);
  where.push(`chunk = $${params.length}`);
}
const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
const rows = await sql.query(
  `SELECT id, reading, chunk, position FROM sprint_sentences ${whereClause} ORDER BY chunk, position`,
  params,
);

if (rows.length === 0) {
  console.log("No rows need audio. Nothing to do.");
  process.exit(0);
}

const publicDir = join(root, "public", "sprint");
mkdirSync(publicDir, { recursive: true });

const tmpDir = mkdtempSync(join(tmpdir(), "sprint-tts-"));

async function synthesizeOne(row) {
  const aiffPath = join(tmpDir, `${row.id}.aiff`);
  const mp3Path = join(publicDir, `${row.id}.mp3`);
  try {
    // Note: AIFF is big-endian; macOS `say` rejects LEF32 into a .aiff container
    // ("Opening output file failed: fmt?", 0-byte file) — verified on this machine.
    // BEF32 (big-endian float) is the AIFF-native equivalent and produces valid audio.
    await execFileAsync("say", ["-v", "Kyoko", "-o", aiffPath, "--data-format=BEF32@22050", row.reading]);
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiffPath, "-codec:a", "libmp3lame", "-qscale:a", "5", mp3Path]);
    return { ok: true };
  } finally {
    try {
      rmSync(aiffPath, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

async function flushUpdates(updates) {
  if (updates.length === 0) return;
  const ids = updates.map((u) => u.id);
  const paths = updates.map((u) => u.audioPath);
  await sql.query(
    `UPDATE sprint_sentences AS s
     SET audio_path = u.audio_path
     FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, audio_path)) AS u
     WHERE s.id = u.id`,
    [ids, paths],
  );
}

let synthesized = 0;
const failures = [];
let pendingUpdates = [];
let processed = 0;

for (const row of rows) {
  processed++;
  const audioPath = `/sprint/${row.id}.mp3`;
  try {
    await synthesizeOne(row);
    pendingUpdates.push({ id: row.id, audioPath });
    synthesized++;
  } catch (err) {
    failures.push({ id: row.id, reading: row.reading, error: err.message });
    console.error(`Failed to synthesize ${row.id} (chunk ${row.chunk}, pos ${row.position}): ${err.message}`);
  }

  if (pendingUpdates.length >= 25) {
    await flushUpdates(pendingUpdates);
    pendingUpdates = [];
  }

  if (processed % 25 === 0) {
    console.log(`Progress: ${processed}/${rows.length} processed (${synthesized} ok, ${failures.length} failed)`);
  }
}

await flushUpdates(pendingUpdates);

try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // best-effort cleanup only
}

console.log(`Synthesized: ${synthesized}/${rows.length}`);
if (failures.length > 0) {
  console.log(`Failures: ${failures.length}`);
  for (const f of failures.slice(0, 10)) {
    console.log(`  ${f.id} (${f.reading}) — ${f.error}`);
  }
}
