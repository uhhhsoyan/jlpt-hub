# 06 — Study ledger + MCP endpoint (reconciled plan, 2026-10-27)

Origin: a build plan drafted in the "Japanese Study" claude.ai project without repo access.
Reconciled against the repo on 2026-10-27 and built the same day. Exam: JLPT N4,
2026-12-06. Feature freeze ~2026-11-22.

## What the repo already covered

| Plan concept | Repo | Gap |
|---|---|---|
| skills inventory | `items` | no Genki refs → written by the import |
| sessions / attempts | `practice_sessions`, `practice_questions`, `question_items` | no root cause, note, level, surface |
| aggregation ledger | `observations` + `lib/mastery.ts` / `lib/weakness.ts` | no root-cause or section facet |
| external snapshots + syncs | `wk_snapshot`, `bp_snapshot`, daily cron | none |
| narrative insights | — | new `insights` table |
| readiness view | `/progress` | no root-cause panel |
| MCP endpoint | — | new `app/mcp/route.ts` |

## Built

- `lib/types.ts`: `ROOT_CAUSES` (grammar-unknown, vocab-in-grammar, reading-selection,
  particle-cue-missed, pattern-glue, misparse, careless, time-pressure), `PracticeSurface`,
  Genki fields on `ItemDetail`.
- `lib/db/schema.ts`: `practice_sessions.surface` (hub | claude-ai | claude-code | import),
  `practice_sessions.timed`, `practice_questions.level/root_cause/note`, `insights`.
- `lib/ledger.ts`: `logAttempts` (session + questions + resolved item links + observations,
  written exactly like `confirmSession`), `logInsight`, `getInsights`, `listSessions`,
  section-name normalizer (moji/goi/bunpou/dokkai/choukai and 文字/語彙/文法/読解/聴解 accepted).
- `lib/weakness.ts`: `getMissesByRootCause(windowDays)`, `getAccuracyBySection(windowDays)`.
- `lib/readiness.ts`: `getCoverage` (moved out of the progress page), `getReadiness`.
- `app/mcp/route.ts`: stateless Streamable HTTP server, bearer auth via `MCP_TOKEN`, tools
  `log_attempts`, `log_insight`, `get_insights`, `get_weakness_report`, `get_readiness`,
  `list_sessions`, `sync_status`.
- `app/progress`: "Why you miss" panel (misses by cause, 14d/30d; accuracy by section, 30d).
- `app/practice/[id]`: root cause + note on each question; surface and timed flag in the header;
  non-URL image refs render as text.
- `scripts/import-ledger.mjs` (`npm run db:import-ledger`): CSV → confirmed sessions,
  Genki refs onto items, unresolved list printed.
- `.mcp.json` for Claude Code; `MCP_TOKEN` in `.env.example`; SETUP.md section.

## Decisions

- One ledger, not two: MCP writes into the existing practice tables.
- MCP-logged sessions are `confirmed` on arrival; the photo + voiceover review in the
  conversation is the review step.
- Stateless transport only (Vercel functions); JSON responses, no SSE.
- Photos are not uploaded through MCP; `image_refs` is a text pointer.
- Classification never blocks capture (2026-11-03). `root_cause` is an open vocabulary:
  `ROOT_CAUSES` is the preferred list, anything else is stored verbatim and shown as a
  "custom" row in the report so new categories can emerge before being promoted. Unknown
  section words fall back to `other` with the raw word in `practice_questions.meta`, a
  JSON sink for any structured fact without a column. The free-text `note` is always kept.
- Practice vs lesson (2026-11-03, after the first real claude.ai session). Open-book work
  (textbook examples, れんしゅう right after the explanation) was feeding mastery like a
  test and masking real gaps. `practice_sessions.mode` separates them: lesson attempts are
  stored as `exposure` observations (unseen → learning) and excluded from accuracy, the
  weak list and the root-cause report. A "studied this, no score" record is a lesson
  session with `correct` null, so no separate log_study tool.
- Unresolved tags are kept and relinked, not re-logged (2026-11-03). Matching tries the
  tag's own kind, then every kind (どちら logged as grammar still finds the vocab item),
  with `items.aliases` for loose spellings (ほど / ほど〜ない / 〜ほど〜ない). Misses come
  back with suggestions; `find_items` looks up canonical forms; `relink_tags` attaches
  evidence once the item exists. Windowed reports say how many practice sessions the
  window holds so an empty result is never mistaken for missing data.
- Sessions are corrected, not re-logged (2026-11-04, after the second claude.ai session
  logged six open-book sets as practice). `update_session` changes mode / label / taken_at
  and rebuilds that session's observations from its question links. Suggestions carry a
  `match` label and an item that is only a prefix of the query (まで for 〜までに) ranks
  last, so a near miss is not read as a hit. Root causes promoted from use:
  context-cue-missed, distractor-bias, kanji-lookalike, katakana-decoding.
- The library is curated, not self-extending (2026-11-09). The grammar list was a generic
  N4/N5 pattern list, not SKM's table of contents, so SKM lessons surface patterns it lacks
  (〜といい sat unresolved on 10 attempts). Keeping the chat out of item creation is
  deliberate: an invented row becomes a permanent mastery item and duplicates the split
  senses. The loop is cheap instead: add the pattern plus the spellings the chat used as
  `aliases` to `data/seed/grammar.json`, pair its Bunpro id in `bunpro-crosswalk.json`,
  `npm run db:seed && npm run db:relink`. 39 patterns were added in one batch from the
  Bunpro N4/N5 points the crosswalk had left unpaired (the crosswalk had also paired
  Bunpro's といい to 〜たほうがいい; repointed). Bare forms of split items (〜から, 〜ている)
  stay ambiguous on purpose; the instructions tell the chat to tag the sense, and to put
  sentence vocabulary on a grammar question in `vocab_gaps` rather than `tags`.
- Study sources are a catalog, not free text (2026-11-04): `study_sources`,
  `practice_sessions.source_id`, `study_log` for time with no graded questions, and the
  `list_sources` / `log_study` tools. See [08 — Study sources](./08-study-sources.md).
- Cut before the freeze: Hindsight sidecar, GCS bucket, embedded Hub chat, weekly Batches
  readiness job, Anki sync, app rename, OAuth on the endpoint.

## Not done in the build session

- `npm run db:push` against production (needs `DATABASE_URL` locally; Vercel marks it sensitive).
- `MCP_TOKEN` added to the Vercel project env.
- CSV import (file lives in the claude.ai project; drop it in `data/import/`).
- Connector added on claude.ai; end-to-end `log_attempts` from the project.
