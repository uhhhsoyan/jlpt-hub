# Plan 04 — Cloud media storage (getting the local-only features deployed)

## Why

Three features touch the local machine, for two distinct reasons:

| Feature | Local piece | Reason |
|---|---|---|
| Practice photos | `public/practice/` storage | Vercel filesystem is ephemeral |
| Sprint audio | `say` TTS **and** `public/sprint/` storage | Mac-only binary + same storage problem |
| Listening mine | whole pipeline + `public/mined/` storage | yt-dlp/whisper binaries + storage |

The DB (Neon) is already shared, which is how the deployed site can claim "100 with audio"
while having zero playable files — the `audioPath`/`imagePaths`/`audioUrl` columns are the
abstraction seam this plan exploits: swap what the strings point at, touch nothing downstream.

## Phase 1 — Vercel Blob for files (built in this repo, PR: feat/blob-media-storage)

- `lib/storage.ts`: `storeFile()` / `deleteStoredFiles()` — Blob when `BLOB_READ_WRITE_TOKEN`
  is set, local `public/` fallback otherwise (local dev works with zero config).
- Practice uploads go through it → **phone photo uploads against the deployed site work**.
- `sprint:tts` uploads MP3s inline when the token is present.
- `npm run media:upload` — idempotent backfill: sweeps sprint audio, mined clips, and practice
  images still on local paths, uploads, rewrites the DB to Blob URLs.
- Setup (one-time): Vercel dashboard → jlpt-hub → Storage → Create → **Blob** (token lands in
  project env automatically) → copy `BLOB_READ_WRITE_TOKEN` into `.env.local` → run
  `npm run media:upload`. Redeploy to pick up the env var.

## Phase 2 — Cloud TTS (not started)

Replace `say` Kyoko with Google Chirp 3 HD ja-JP (research doc's ranked pick; ~free at this
volume; kana-fed like today). TTS becomes an API call + Blob write → can run as a server
action or Vercel cron; sprint audio generation stops needing the Mac. Same `audioPath`
contract, no downstream changes.

## Phase 3 — Hybrid mine (not started)

Cloud-side mining is deliberately out: yt-dlp from datacenter IPs is unreliable (YouTube
blocks), and whisper needs real binaries. Keep mining local; `media:upload` already pushes the
resulting clips to Blob so Sandwich mode and clip playback work deployed. Optional later:
fold the upload into the mine action itself.
