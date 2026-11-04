# 08 — Study sources catalog (2026-11-04)

## Purpose

Every book, question bank, official workbook and app Eric studies from is a first-class
thing the Hub knows about, instead of a free-text `practice_sessions.source_name`. That
gives three things:

- a visual grid at `/sources` showing what is in use and how much (sessions, minutes,
  last used), with add/edit in the Hub (never delete: `active=false` hides);
- a way for the MCP tools to say "this session is from that source" (`source` on
  `log_attempts` / `update_session`, resolved by slug, name or alias);
- a place for study that produces no graded questions (30 minutes in Satori Reader, a
  WaniKani review session, a listening pass): `log_study` writes `study_log` rows.

## Model

`lib/db/schema.ts`, unions in `lib/types.ts`:

- `study_sources`: `id`, `slug` (unique, permanent), `name`, `name_ja`, `kind`
  (`textbook | workbook | question-bank | official-test | app | reader`), `level`
  ("N4", "N5", "N4-N5"), `edition`, `url`, `image_url`, `color` (hex for the placeholder
  card), `aliases` (jsonb string[]), `sort_order`, `active`, `description` (what it is),
  `how_used` (how it fits the plan, so the logging agent knows which mode/tool to use),
  `notes`, `created_at`.
- `practice_sessions.source_id` → `study_sources` (nullable, `on delete set null`).
  `source_name` stays as free text for the detail (lesson, page) and for sessions whose
  text matched nothing.
- `study_log`: `id`, `source_id`, `activity` (`reading | listening | review | lesson |
  drill | other`), `minutes`, `taken_at`, `note`, `meta`, `surface`, `created_at`.
  No item evidence on purpose: app answers arrive through their own syncs, and graded work
  belongs in `log_attempts`.

Seed: `data/seed/study-sources.json` → `npm run db:seed-sources`
(`scripts/seed-study-sources.mjs`), upsert on slug. Re-seeding updates every descriptive
field and the aliases but keeps an `image_url` set in the Hub (the seed's `imageUrl` is
null) and never touches `active`. Seeded entries: the five 新完全マスター N4 volumes
(`skm-n4-bunpou/goi/kanji/dokkai/choukai`), Genki I/II textbook + workbook
(`genki-1`, `genki-1-workbook`, `genki-2`, `genki-2-workbook`), 新にほんご500問 N4-N5
(`shin-nihongo-500-mon-n4-n5`), the four official JLPT workbooks
(`jlpt-official-n5-2012`, `-n5-2018`, `-n4-2012`, `-n4-2018`), and `wanikani`,
`bunpro`, `satori-reader`.

## Resolution (`lib/study-sources.ts`, pure; `lib/study-sources-db.ts` wraps it)

`resolveSource(sources, text)` compares NFKC-normalised, lower-cased, whitespace-stripped
strings, in order: slug exactly → name / nameJa exactly → alias exactly → substring.
Substring runs both ways over name, nameJa and aliases (keys under 3 characters are
skipped):

- key inside the text (`新完全マスター 文法 N4` inside `新完全マスター 文法 N4 — 実力養成編
  第1部 2課`): the text names a source and adds detail. The longest matched key wins
  (`Genki II` beats `Genki I` inside `Genki II L14`); a tie between different sources is
  ambiguous → null.
- text inside a key (`500 mon` inside `shin nihongo 500 mon n4-n5`): only when exactly one
  source matches.

Ambiguity never guesses: `Genki`, `公式問題集` and `新完全マスター` alone return null.
Tests in `lib/study-sources.test.ts` load the real seed file, so every alias is checked
against the catalog that ships, including the two strings already in the ledger.

In `logAttempts` the explicit `source` is tried first, else `source_name`; whichever was
tried and failed comes back as `sourceUnresolved` while the text is still kept on the
session. `updateSession` takes `source` too (`"none"` unlinks; an unknown name errors,
listing the slugs). `listSessions` / `SessionSummary` carry `source: {slug, name} | null`.

## MCP (`app/mcp/route.ts`, server version 1.3.0)

- `log_attempts`: new optional `source` (slug / name / alias). `source_name` becomes the
  lesson/page detail when `source` is given, or the book name when it is not. Result adds
  `source` and `sourceUnresolved`.
- `update_session`: new optional `source` (or `"none"`).
- `list_sources` (read-only): slug, name, nameJa, kind, level, description, howUsed, plus
  sessions / practiceSessions / lessonSessions / lastSessionAt / studyLogEntries /
  studyMinutes / lastStudyLogAt. `include_inactive` shows hidden sources.
- `log_study`: `{ source (required), activity, minutes?, taken_at, note?, meta?, surface }`
  → inserts into `study_log`; errors with the valid slugs when the source does not resolve.

`docs/claude-ai-project-instructions.md` has the matching "Study sources" section for the
claude.ai project.

## Hub UI

- Nav tab **Sources** → `/sources`: cards grouped by kind (textbook, workbook, question
  bank, official test, app, reader), 2 columns on a phone and 3–4 on desktop, each with
  the picture or placeholder, name, Japanese title, level badge, kind, the description
  (two lines) and a stats line (lessons · practice · minutes · last used). Inactive
  sources are hidden. "Add source" → `/sources/new`.
- `/sources/[slug]`: full details, description and how-used, four stat tiles, the
  source's sessions (linking to `/practice/[id]`) and its study-log entries, newest first.
  "Edit" → `/sources/[slug]/edit`.
- `/sources/new` and `/sources/[slug]/edit` share `app/sources/source-form.tsx` (server
  actions in `app/sources/actions.ts`). The slug is derived from the name
  (`slugify`: ASCII, hyphenated; an all-Japanese name gets `source-<8 hex>`), shown live
  under the name field, and fixed once created; a collision is an inline error. Edit adds
  `active` and the image controls.
- `/practice` new-session form: a `<select>` of active sources (plus "Other / none") and a
  "Detail (lesson / page)" text field that still writes `source_name`; the session stores
  `source_id`. The session list and detail page link the source.

## Images

The card shows, in order: `image_url`; a file at `public/sources/<slug>.{jpg,jpeg,png,webp}`
if one exists at request time (`app/sources/image.ts`; `next.config.ts` traces that folder
into the `/sources` functions on Vercel); else the typographic placeholder in the source's
colour. No publisher or brand images are shipped. To add a picture:

- drop a photo of the book into `public/sources/<slug>.jpg` and commit it, or
- on `/sources/<slug>/edit`, upload a JPEG/PNG/WebP (≤ 5 MB). With `BLOB_READ_WRITE_TOKEN`
  set it goes to Vercel Blob (`access: public`) under `sources/<slug>-<stamp>.<ext>` — a
  fresh pathname each time so no CDN cache serves the old photo; the previous upload is
  deleted. Without the token the form says so and the file lands in `public/sources/`
  locally (does not survive a deploy); or
- paste an image URL into the same form. "Remove image" nulls `image_url` and the
  placeholder (or the `public/sources` file) shows again.

## Adding a source

Either the Hub form, or an entry in `data/seed/study-sources.json` followed by
`npm run db:seed-sources` (preferred for anything that should survive a fresh database).
Give it aliases for every way a log might name it, then `npm run db:backfill-sources`
links any older session whose `source_name` now resolves.

## Post-merge steps, in order

1. `npm run db:push` — adds `study_sources`, `study_log`, `practice_sessions.source_id`.
2. `npm run db:seed-sources` — loads the catalog.
3. `npm run db:backfill-sources` — resolves existing sessions' `source_name` to
   `source_id` (idempotent; prints matches and misses). At the time of writing every
   session in the ledger resolves: the 500問 imports and the SKM 文法 lesson sessions.
4. Paste the updated block from `docs/claude-ai-project-instructions.md` into the claude.ai
   project; reconnect the connector if it caches the tool list.

## Decisions

- Slugs are permanent and human-readable (`skm-n4-bunpou`), not uuids: they appear in MCP
  calls and URLs, and the claude.ai instructions list them.
- Resolution is deliberately conservative (null on ambiguity) and reported back
  (`sourceUnresolved`) rather than guessed, in the spirit of "capture first, classify
  later": the text is kept, an alias fixes it, the backfill relinks.
- `study_log` writes no observations. Minutes in an app are not item evidence, and the
  syncs already cover WaniKani and Bunpro at item level. This supersedes the 06 note that
  "studied this, no score" is a lesson session with `correct` null — that remains right
  for *questions* done open-book; `log_study` is for time with no questions at all.
- Backfill is a `.mts` script (not `.mjs`) so it imports the same resolver the MCP tools
  use instead of a copy that would drift.
- Uploaded pictures get a unique pathname per upload (cache-busting) rather than
  overwriting `sources/<slug>.<ext>` in Blob.
