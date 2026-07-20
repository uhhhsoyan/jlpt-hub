# 2026-07-20 — Sprint audio cascade fix + Blob storage (cloud phase 1)

- **Model:** Claude Fable 5 (`claude-fable-5`), sonnet subagent for the Blob implementation
- **Session id:** `3003a7a5-0973-4f9f-8644-3d18f21cde4e` (same session as
  [the build log](./2026-07-20_library-graph-sprint-build.md) — this covers the post-merge arc)
- **Raw transcript:** `docs/sessions/raw/2026-07-20_audio-cascade-and-blob-storage.jsonl`
  (gitignored; supersedes and includes the earlier raw copy, which was removed)

## Goal

Two follow-ons after the three feature PRs merged: fix the Sprint Listen tab racing through
the whole deck on the deployed site with no interaction, and build cloud storage Phase 1 so
the local-only media features work when deployed.

## What we built (chronological)

1. **Diagnosed the racing Listen tab.** `onError={advance}` on the shared `<audio>` element:
   the deployed DB says every row has `audioPath`, but the MP3s live only in local
   `public/sprint/` — every load 404s → error → advance → next error → full-deck walk, looping
   forever, and each phantom "pass" incremented `listenCount` (was 2; reset to 0 in the DB).
2. **PR #5 — `fix/sprint-audio-error-cascade`.** Errors before the user presses Play never
   auto-advance; 5 consecutive errors during playback stop with a notice explaining audio is
   local-only; passes only count as listens when ≥1 track actually finished; Play retries a
   failed src. Same guards on the Sandwich tab (which wrapped around, so it could never stop).
3. **Clarified the local-only split for Sprint**: recall/drilling works deployed (observations
   reach Neon — the phantom counts proved prod env vars are wired); anything that *plays* audio
   was local-only. That teed up Phase 1.
4. **PR #6 — `feat/blob-media-storage`** (sonnet-built to a tight brief, current Blob API pulled
   via the vercel-storage skill): `lib/storage.ts` (`storeFile`/`deleteStoredFiles`, Blob when
   `BLOB_READ_WRITE_TOKEN` set, `public/` fallback otherwise, traversal-guarded); practice
   photo uploads routed through it (phone-photo uploads against the deployed site now possible);
   `sprint:tts` uploads inline when the token exists; `npm run media:upload` idempotently
   backfills sprint audio + mined clips + practice images onto Blob URLs. Plan doc
   `docs/plans/04-cloud-storage.md` records Phases 1–3.

## Key decisions & rationale

- **Error handling semantics:** an error cascade must be distinguished from normal advance —
  never navigate on a load error before user intent (Play), cap consecutive failures, and
  don't let failure-walks write progress data (`listenCount` requires ≥1 real completion).
- **Storage as a seam, not a migration:** `audioPath`/`audioUrl`/`imagePaths` strings are the
  only contract; Blob vs local is decided at write time by token presence. Local dev needs no
  token and behaves exactly as before. No `next/image` anywhere, so absolute Blob URLs render
  without config changes.
- **`media:upload` is a separate idempotent sweep** rather than only inline uploads, because
  media already exists locally (deck 0's 100 MP3s, mined clips) and the mine pipeline stays
  local-first by design (yt-dlp from datacenter IPs is unreliable — Phase 3 stays hybrid).
- Earlier in the session (see the build log): the Vercel prod 404 root cause was Framework
  Preset "Other", captured because the project was imported when the repo was README-only.

## Deliverables / pointers

- [PR #5 — sprint audio error cascade fix](https://github.com/uhhhsoyan/jlpt-hub/pull/5) (open)
- [PR #6 — Vercel Blob media storage](https://github.com/uhhhsoyan/jlpt-hub/pull/6) (open;
  new dependency `@vercel/blob`)
- `docs/plans/04-cloud-storage.md` — the Phase 1–3 roadmap (in PR #6)
- DB hygiene: `sprint_chunks.listen_count` for chunk 0 reset to 0 (phantom passes)
- Repo setting change (earlier today): `delete_branch_on_merge=true` on `uhhhsoyan/jlpt-hub`

## Open threads / next steps

1. **Merge PR #5 and #6** (squash; they're independent).
2. **Blob setup (Eric, one-time):** Vercel dashboard → jlpt-hub → Storage → Create → Blob;
   copy `BLOB_READ_WRITE_TOKEN` into `.env.local`; run `npm run media:upload`; redeploy.
   First `media:upload` run is the real live test of the upload path.
3. Phase 2 (cloud TTS via Chirp 3 HD) and Phase 3 (mine uploads folded into the mine action)
   remain unstarted — see plan 04.
4. Still open from the build log: WaniKani live sync test, first real practice-photo
   extraction, remaining ~1,064 sprint words, elzup supplement pass for missing list basics.
5. The session-log markdown files themselves are uncommitted on main — fold into a branch/PR
   when convenient.
