# 2026-07-17 → 2026-07-20 — Plan, build, and ship: library, knowledge graph, vocab sprint

- **Model:** Claude Fable 5 (`claude-fable-5`), with sonnet subagents for implementation
- **Session id:** `3003a7a5-0973-4f9f-8644-3d18f21cde4e`
- **Raw transcript:** `docs/sessions/raw/2026-07-20_library-graph-sprint-build.jsonl` (gitignored)

## Goal

Started as a planning brain dump (Eric): ingest the published JLPT N4/N5 vocab/kanji lists,
explore whether a "knowledge graph" of study progress is worth building, and evaluate a YouTube
polyglot's brute-force vocab method for something buildable. Ended as: plan all three, then build
and ship all three as stacked PRs, plus fix the Vercel production 404.

## What we built (chronological)

1. **Research & planning (07-17).** Fetched the nihongoichiban N5/N4 lists (N5 vocab ~700, N4
   kanji list found at a URL Eric didn't have), identified the practice book (Shin Nihongo 500
   Mon N4–N5), and pulled the full transcript of the video (Mikel | Hyperpolyglot, "Learn 2000
   Words in 7 Days"). Discovered the existing `research/2026-07-10-jlpt-n4-tooling-research.md`
   and `anki-tools/` — both heavily shaped the plans. Wrote `docs/plans/01–03` + README.
2. **Plan 01 — Reference library** (`PR #2`). Stdlib-python scraper → checked-in seed JSON →
   `items` + `item_edges` tables → `npm run db:seed` → `/library` UI (gojūon-grouped vocab,
   kanji grid with words-using-kanji, mastery-dot placeholder).
3. **Plan 02 — Knowledge graph** (`PR #3`). `observations` evidence ledger + read-time mastery
   (`lib/mastery.ts`); 188 curated grammar points seeded; workshop-sentence backfill;
   `/practice` photo loop (Claude vision extraction → staged human confirm → answer
   observations); WaniKani sync module (`lib/wanikani.ts`, untested — needs token); `/progress`
   dashboard (coverage bars, weak points, evidence volume, Dec 6 countdown).
4. **Plan 03 — Vocab sprint** (`PR #4`). `sprint_sentences`/`sprint_chunks`;
   `scripts/generate-sprint.mjs` (claude-sonnet-5 batched generation + kuromoji
   tokenize→lemma-match→re-prompt validation); `scripts/tts-sprint.mjs` (kana-fed `say` Kyoko →
   ffmpeg MP3); `/sprint` trainer with Listen / Read-along / Recall (self-grade → observations) /
   Sandwich (timed alternation with mined clips). Deck 0 generated live: 100 sentences, 92
   strictly validated, 100 MP3s.
5. **Vercel 404 fix (07-17→07-20).** Production domain served platform `404 NOT_FOUND` since
   before these PRs. Root cause: the Vercel project was imported when the repo contained **only
   a README** (`935911e`), so Framework Preset was captured as "Other" — deployments "succeeded"
   with no servable output. Fix: Settings → Framework Preset → Next.js, redeploy (Eric did it in
   the dashboard; confirmed working).
6. **Merge day (07-20).** Enabled `delete_branch_on_merge` on the repo (that's the setting that
   makes GitHub auto-retarget stacked PRs). Squash-merged #2 → #3 → #4, rebasing the child
   branch between each merge (`git rebase --onto origin/main <old-parent-tip> <child>`) because
   squash rewrites SHAs and re-conflicts the children. Final main: one clean commit per PR.

## Key decisions & rationale

- **Knowledge graph = data model, not infrastructure.** Postgres tables (`items`, `item_edges`,
  `observations`) are the graph; Neo4j etc. buys nothing at ~2k nodes / single user.
- **Mastery computed at read time**, not materialized (deviation from plan doc): avoids
  recompute plumbing in every write path; trivially fast at this scale. Formula: 30-day-half-life
  decayed answer accuracy, blended 60/40 with latest SRS stage; exposure-only floor capped at 0.3.
- **Staged confirm before evidence.** Vision extraction lands in `review` status; observations
  are written only on confirm — bad evidence is worse than a 10-second review step.
- **Validation loop is mandatory for generated sentences** (research doc / arXiv 2506.04072:
  prompting alone doesn't hold JLPT level). kuromoji is a devDependency because it runs only in
  local scripts.
- **Kana-fed TTS** to dodge kanji misreadings; `say` needs `BEF32` not `LEF32` for AIFF
  (silently writes 0 bytes otherwise — subagent caught this).
- **The N4 source list is NOT cumulative** (677 rows, 183 overlapping N5); N5 list is missing
  basics (犬, 水 — the sprint validator flagged 水 live). Deltas vs the community elzup list are
  in `data/seed/SCRAPE-REPORT.md`; a supplement pass is a natural follow-up.
- **WK snapshot semantics:** WaniKani removed review history (2023), so sync replaces
  `source='wanikani'` observations wholesale each run.
- **Squash + stacked PRs:** squash rewrites parent SHAs, so each child needs
  `rebase --onto main <old-parent-tip>` after the parent merges. Accepted as the price of
  one-commit-per-PR history; future work should branch serially off main instead of stacking.

## Deliverables / pointers

- PRs (all merged): [#2 library](https://github.com/uhhhsoyan/jlpt-hub/pull/2),
  [#3 knowledge graph](https://github.com/uhhhsoyan/jlpt-hub/pull/3),
  [#4 vocab sprint](https://github.com/uhhhsoyan/jlpt-hub/pull/4)
- Plans: `docs/plans/01-reference-library.md`, `02-knowledge-graph.md`, `03-vocab-sprint.md`
- Data: `data/seed/*.json` (+ `SCRAPE-REPORT.md`), 1,164 vocab / 284 kanji / 188 grammar seeded,
  deck 0 sentences + `public/sprint/*.mp3` (gitignored, local)
- New scripts: `db:seed`, `db:backfill-workshop`, `sprint:generate`, `sprint:tts`
- New dep: `kuromoji` (dev). New env var: `WANIKANI_TOKEN` (documented in `.env.example`)

## Open threads / next steps

1. **Needs Eric:** WaniKani live sync test (token → /progress → Sync); first real practice-photo
   extraction (spends opus credits); one manual pass through /sprint recall + sandwich flows.
2. **Cloud storage plan** (discussed, not yet written as a plan doc): Phase 1 Vercel Blob for
   practice images + sprint audio (unlocks phone photo uploads against the deployed site);
   Phase 2 cloud TTS (Chirp 3 HD, free tier) behind the same `audioPath` contract; Phase 3
   hybrid mine (local yt-dlp/whisper, clips uploaded to Blob). Mine stays local-first — yt-dlp
   from datacenter IPs is unreliable.
3. elzup supplement pass for the missing N5/N4 basics; re-validate flagged deck-0 sentences.
4. Remaining sprint decks: `npm run sprint:generate` + `sprint:tts` (~1,064 words to go).
5. Vercel prod env vars (`ANTHROPIC_API_KEY`, `DATABASE_URL`) + decide on deployment protection.
6. Workshop v1.5 (tokenizer validation inside the workshop server action) — the sprint script
   has the loop; the workshop still relies on prompting alone.
