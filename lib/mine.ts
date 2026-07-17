// Local-only YouTube → per-sentence audio mining. Runs yt-dlp + whisper.cpp +
// ffmpeg via child processes, so it CANNOT run on Vercel serverless — only when
// the app is run locally (`npm run dev`).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const OPTS = { maxBuffer: 64 * 1024 * 1024 } as const;

const WHISPER_CLI = process.env.WHISPER_CLI || "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "";
const CLIP_PAD = 0.25; // seconds of headroom so the first/last mora isn't clipped

export interface MinedSegment {
  index: number;
  text: string;
  start: number;
  end: number;
  reads: number; // how many consecutive near-identical reads collapsed into this clip
  clipUrl: string; // served from /public, e.g. /mined/<id>/clip_0003.mp3
}
export interface MineResult {
  videoId: string;
  title: string;
  url: string;
  segments: MinedSegment[];
}

export class MineError extends Error {}

function assertLocal() {
  if (process.env.VERCEL) {
    throw new MineError("Mining is local-only — yt-dlp/whisper/ffmpeg can't run on Vercel.");
  }
}

async function ensureTool(name: string, hint: string) {
  try {
    await run(name, ["--version"], OPTS);
  } catch (e) {
    // Only a missing binary is fatal; a non-zero exit / unknown flag (e.g.
    // whisper-cli not supporting --version) means the binary IS there.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new MineError(`\`${name}\` not found. ${hint}`);
    }
  }
}

function parseYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/** whisper.cpp JSON → segments. Tolerant of the offsets(ms) shape it emits. */
function parseWhisperJson(raw: string): { start: number; end: number; text: string }[] {
  const data = JSON.parse(raw) as {
    transcription?: { offsets?: { from: number; to: number }; text?: string }[];
  };
  const out: { start: number; end: number; text: string }[] = [];
  for (const seg of data.transcription ?? []) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    out.push({
      start: (seg.offsets?.from ?? 0) / 1000,
      end: (seg.offsets?.to ?? 0) / 1000,
      text,
    });
  }
  return out;
}

const READ_MAX_GAP = 10; // s — reads of the same sentence sit close together
const READ_SIMILARITY = 0.85;

interface RawSeg {
  start: number;
  end: number;
  text: string;
}
interface Group extends RawSeg {
  reads: number;
}

function normalize(t: string): string {
  // Drop whitespace and JA/EN punctuation so the 3 reads compare equal.
  return t.replace(/[\s、。，．！？!?「」『』（）()・…~〜ー]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function sameRead(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  const ratio = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return ratio >= READ_SIMILARITY;
}

/**
 * Collapse consecutive near-identical segments (the same sentence read 2-3×,
 * as Mochi Sensei does) into a single entry. Keeps the longest read's timing as
 * the representative clip and the longest transcription as the text.
 */
function pickRep(run: RawSeg[]): RawSeg {
  const rep = run.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const text = run.reduce((a, b) => (b.text.length > a.text.length ? b : a)).text;
  return { start: rep.start, end: rep.end, text };
}

export function collapseReads(segs: RawSeg[]): Group[] {
  // Stage 1 — merge CONSECUTIVE near-identical segments into one "cluster".
  // This kills Whisper repetition loops on silence/music (the same line emitted
  // many times in a row) and any back-to-back duplicate.
  const runs: RawSeg[][] = [];
  for (const s of segs) {
    const run = runs[runs.length - 1];
    const anchor = run?.[run.length - 1];
    if (anchor && s.start - anchor.end <= READ_MAX_GAP && sameRead(s.text, anchor.text)) run.push(s);
    else runs.push([s]);
  }
  const clusters = runs.map(pickRep);

  // Stage 2 — dedup across the WHOLE video. These videos read a passage 2-3×,
  // with the repeats far apart (not back-to-back), so the same sentence recurs
  // non-adjacently. Fold those into one row; `reads` = how many separate times
  // the sentence is spoken. Keep first-occurrence order and the longest read.
  const groups: RawSeg[][] = [];
  for (const c of clusters) {
    const g = groups.find((members) => sameRead(members[0].text, c.text));
    if (g) g.push(c);
    else groups.push([c]);
  }
  return groups.map((members) => {
    const rep = pickRep(members);
    return { ...rep, reads: members.length };
  });
}

export async function mineVideo(url: string, limit?: number): Promise<MineResult> {
  assertLocal();
  const videoId = parseYouTubeId(url);
  if (!videoId) throw new MineError("That doesn't look like a YouTube video URL.");
  if (!WHISPER_MODEL || !existsSync(WHISPER_MODEL)) {
    throw new MineError(
      "Whisper model not configured. Set WHISPER_MODEL in .env.local to a ggml model path (see SETUP.md).",
    );
  }
  await ensureTool("yt-dlp", "Install with `brew install yt-dlp`.");
  await ensureTool("ffmpeg", "Install with `brew install ffmpeg`.");
  await ensureTool(WHISPER_CLI, "Install with `brew install whisper-cpp` (or set WHISPER_CLI).");

  const work = path.join(os.tmpdir(), `n4mine-${videoId}`);
  await mkdir(work, { recursive: true });
  const clipsDir = path.join(process.cwd(), "public", "mined", videoId);
  await mkdir(clipsDir, { recursive: true });

  try {
    // 1. Title + full audio.
    const { stdout: meta } = await run(
      "yt-dlp",
      ["--skip-download", "--print", "%(title)s", url],
      OPTS,
    );
    const title = meta.trim() || videoId;

    const audio = path.join(work, "audio.mp3");
    await run(
      "yt-dlp",
      ["-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", audio, url],
      OPTS,
    );

    // 2. 16 kHz mono WAV for whisper.cpp.
    const wav = path.join(work, "audio16k.wav");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", audio, "-ar", "16000", "-ac", "1", wav], OPTS);

    // 3. Transcribe (Japanese) → JSON with segment offsets.
    const outBase = path.join(work, "transcript");
    await run(WHISPER_CLI, ["-m", WHISPER_MODEL, "-f", wav, "-l", "ja", "-oj", "-of", outBase], OPTS);
    let raw: string;
    try {
      raw = await readFile(`${outBase}.json`, "utf8");
    } catch {
      throw new MineError("Whisper produced no JSON output — check the model path and whisper-cli.");
    }
    // Collapse the 3× repeated reads into one entry each, then cap if asked.
    let groups = collapseReads(parseWhisperJson(raw));
    if (limit) groups = groups.slice(0, limit);

    // 4. Slice one clip per collapsed sentence from the original audio.
    const segments: MinedSegment[] = [];
    for (let i = 0; i < groups.length; i++) {
      const seg = groups[i];
      const name = `clip_${String(i).padStart(4, "0")}.mp3`;
      const seek = Math.max(0, seg.start - CLIP_PAD);
      const dur = Math.max(0.2, seg.end - seg.start + 2 * CLIP_PAD);
      await run(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-ss", seek.toFixed(3), "-i", audio, "-t", dur.toFixed(3),
          "-codec:a", "libmp3lame", "-qscale:a", "4", path.join(clipsDir, name)],
        OPTS,
      );
      segments.push({
        index: i,
        text: seg.text,
        start: seg.start,
        end: seg.end,
        reads: seg.reads,
        clipUrl: `/mined/${videoId}/clip_${name.slice(5)}`,
      });
    }
    return { videoId, title, url, segments };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
