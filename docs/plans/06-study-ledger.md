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
- Cut before the freeze: Hindsight sidecar, GCS bucket, embedded Hub chat, weekly Batches
  readiness job, Anki sync, app rename, OAuth on the endpoint.

## Not done in the build session

- `npm run db:push` against production (needs `DATABASE_URL` locally; Vercel marks it sensitive).
- `MCP_TOKEN` added to the Vercel project env.
- CSV import (file lives in the claude.ai project; drop it in `data/import/`).
- Connector added on claude.ai; end-to-end `log_attempts` from the project.
