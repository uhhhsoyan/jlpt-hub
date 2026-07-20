// One-shot backfill/sync: uploads any media still on a local public/ path (sprint
// sentence audio, mined listening clips, practice-session images) to Vercel Blob and
// rewrites the DB rows to point at the returned Blob URL. Idempotent — only rows still
// on a local path are touched, so re-running only picks up whatever's left.
//
// Usage: npm run media:upload   (node --env-file=.env.local scripts/upload-media.mjs)
import { neon } from "@neondatabase/serverless";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blobEnabled, uploadLocalFile } from "./blob-util.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!blobEnabled()) {
  console.error(
    [
      "BLOB_READ_WRITE_TOKEN is not set — there's no Blob store to upload to.",
      "Create one: Vercel dashboard → project jlpt-hub → Storage → Create → Blob,",
      "then copy the BLOB_READ_WRITE_TOKEN it gives you into .env.local.",
    ].join("\n"),
  );
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(dbUrl);

const EXT_CONTENT_TYPE = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

function contentTypeFor(localPath) {
  const ext = localPath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

function localFilePath(publicPath) {
  return join(root, "public", publicPath.replace(/^\//, ""));
}

const report = {
  sprint: { uploaded: 0, skipped: 0, failed: 0 },
  clips: { uploaded: 0, skipped: 0, failed: 0 },
  practice: { uploaded: 0, skipped: 0, failed: 0 },
};

// --- sprint_sentences.audio_path ---
async function migrateSprintSentences() {
  const rows = await sql.query(`SELECT id, audio_path FROM sprint_sentences WHERE audio_path LIKE '/sprint/%'`);
  const updates = [];
  for (const row of rows) {
    const local = localFilePath(row.audio_path);
    if (!existsSync(local)) {
      console.warn(`sprint_sentences ${row.id}: missing ${row.audio_path}, skipping.`);
      report.sprint.skipped++;
      continue;
    }
    try {
      const pathname = row.audio_path.replace(/^\//, "");
      const url = await uploadLocalFile(local, pathname, contentTypeFor(local));
      updates.push({ id: row.id, value: url });
      report.sprint.uploaded++;
    } catch (e) {
      console.error(`sprint_sentences ${row.id}: upload failed — ${e.message}`);
      report.sprint.failed++;
    }
  }
  if (updates.length > 0) {
    await sql.query(
      `UPDATE sprint_sentences AS s SET audio_path = u.audio_path
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, audio_path)) AS u
       WHERE s.id = u.id`,
      [updates.map((u) => u.id), updates.map((u) => u.value)],
    );
  }
}

// --- clips.audio_url ---
async function migrateClips() {
  const rows = await sql.query(`SELECT id, audio_url FROM clips WHERE audio_url LIKE '/mined/%'`);
  const updates = [];
  for (const row of rows) {
    const local = localFilePath(row.audio_url);
    if (!existsSync(local)) {
      console.warn(`clips ${row.id}: missing ${row.audio_url}, skipping.`);
      report.clips.skipped++;
      continue;
    }
    try {
      const pathname = row.audio_url.replace(/^\//, "");
      const url = await uploadLocalFile(local, pathname, contentTypeFor(local));
      updates.push({ id: row.id, value: url });
      report.clips.uploaded++;
    } catch (e) {
      console.error(`clips ${row.id}: upload failed — ${e.message}`);
      report.clips.failed++;
    }
  }
  if (updates.length > 0) {
    await sql.query(
      `UPDATE clips AS c SET audio_url = u.audio_url
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, audio_url)) AS u
       WHERE c.id = u.id`,
      [updates.map((u) => u.id), updates.map((u) => u.value)],
    );
  }
}

// --- practice_sessions.image_paths (jsonb string[]) ---
async function migratePracticeSessions() {
  const rows = await sql.query(
    `SELECT id, image_paths FROM practice_sessions WHERE image_paths::text LIKE '%/practice/%'`,
  );
  const updates = [];
  for (const row of rows) {
    let changed = false;
    const newPaths = [];
    for (const p of row.image_paths) {
      if (typeof p !== "string" || !p.startsWith("/practice/")) {
        newPaths.push(p); // already an https URL (or unexpected shape) — leave untouched
        continue;
      }
      const local = localFilePath(p);
      if (!existsSync(local)) {
        console.warn(`practice_sessions ${row.id}: missing ${p}, skipping (entry left unchanged).`);
        report.practice.skipped++;
        newPaths.push(p);
        continue;
      }
      try {
        const pathname = p.replace(/^\//, "");
        const url = await uploadLocalFile(local, pathname, contentTypeFor(local));
        newPaths.push(url);
        report.practice.uploaded++;
        changed = true;
      } catch (e) {
        console.error(`practice_sessions ${row.id}: upload failed for ${p} — ${e.message}`);
        report.practice.failed++;
        newPaths.push(p);
      }
    }
    if (changed) updates.push({ id: row.id, value: newPaths });
  }
  if (updates.length > 0) {
    await sql.query(
      `UPDATE practice_sessions AS ps SET image_paths = u.image_paths
       FROM (SELECT * FROM unnest($1::uuid[], $2::jsonb[]) AS t(id, image_paths)) AS u
       WHERE ps.id = u.id`,
      [updates.map((u) => u.id), updates.map((u) => JSON.stringify(u.value))],
    );
  }
}

await migrateSprintSentences();
await migrateClips();
await migratePracticeSessions();

console.log("Media upload report:");
console.log(
  `  sprint_sentences: ${report.sprint.uploaded} uploaded, ${report.sprint.skipped} skipped, ${report.sprint.failed} failed`,
);
console.log(
  `  clips: ${report.clips.uploaded} uploaded, ${report.clips.skipped} skipped, ${report.clips.failed} failed`,
);
console.log(
  `  practice_sessions images: ${report.practice.uploaded} uploaded, ${report.practice.skipped} skipped, ${report.practice.failed} failed`,
);
