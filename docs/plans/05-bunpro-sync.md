# Bunpro sync — read-only grammar evidence

Pulls the user's grammar SRS state from Bunpro into the `observations` ledger
(`source='bunpro'`), mirroring the WaniKani sync. Grammar was previously the thinnest
evidence source — WaniKani only covers kanji/vocab.

## The API situation (read before touching lib/bunpro.ts)

Bunpro has **no official public API**. The documented v3/v4 API was deprecated in 2024
and **removed entirely on 2026-04-21**, breaking community tools overnight. What we use
is the undocumented "frontend API" that powers bunpro.jp itself:

- Staff have explicitly permitted reverse-engineering it ("they may change without
  warning") — see community threads "Bunpro API when?" and "Permission to reverse
  engineer the Bunpro API".
- In April 2026 Bunpro added `?dangerously_authenticate_using_api_token=true`, which
  lets the long-lived API key from bunpro.jp/settings/api authenticate frontend
  endpoints as a Bearer token — built for exactly this kind of integration.
- Community OpenAPI spec (partial): github.com/cbullard-dev/bunpro-community-api.

Consequences baked into the code:

- `lib/bunpro.ts` parses defensively (multiple envelope/field-name candidates) and
  refuses to write anything on unrecognized shapes ("schema drift" error) rather than
  recording garbage.
- Requests are throttled; the whole sync is a handful of pages.
- Expect this to break someday. The fix will usually be renaming a field in
  `parseReview` / `reviewListOf`.

## Endpoints used

- `GET /api/frontend/reviews?page=N&per_page=100` (auth) — the user's review rows:
  `grammar_point_id` / `reviewable_type` + `reviewable_id`, `srs_stage`, `burned`,
  `last_review`-style timestamps. Ghost reviews can produce several rows per grammar
  point; the sync keeps the latest per mapped item.
- `GET /api/frontend/reviewables/grammar_point/{id}` (public) — catalog metadata:
  id, title (the pattern string), slug, level ("JLPT5".."JLPT1"), meaning. Fetched
  once by `npm run bunpro:catalog` into `data/seed/bunpro-grammar.json` (committed).

## Crosswalk

`data/seed/bunpro-crosswalk.json` (committed, human-editable) maps Bunpro point id →
curated grammar headword. Built by `npm run bunpro:crosswalk` in two passes:

1. Deterministic normalized-string matching (NFKC, strip 〜/parentheticals, split
   ・-variants), accepted only when unambiguous — ~92 of 317 N5/N4 points.
2. One Claude call pairs the leftovers semantically (可能形 ↔ "Potential Form",
   そうだ 伝聞 vs 様態 via Bunpro's meaning field) — ~122 more. Pairs referencing
   unknown ids/headwords are rejected.

Result: 214/317 points paired, covering 156/188 curated grammar items; the uncovered
rest are mostly conjugation-drill items Bunpro folds elsewhere (ました/ません) or
patterns Bunpro files under N3. The runtime sync only reads the JSON (headwords are
resolved to item ids at sync time, so db reseeds don't break it) and persists
`detail.bpGrammarPointId` (same pattern as `wkSubjectId`). Several points may map to
one item — fine for evidence; the latest review per item wins. Hand-edit the JSON to
fix a bad pair; rebuilds overwrite hand-edits.

## SRS scale

Bunpro SRS runs 1..12 (+ burned); our mastery math (`lib/mastery.ts`) assumes
WaniKani's 0..9. Stages are scaled `round(stage * 9/12)` at write time (burned → 9);
the raw stage is kept in `meta.bpSrsStage`.

## Reversibility (applies to WaniKani too)

Design rule for every external integration: **evidence is source-tagged, mastery is
computed at read time, so an integration's entire contribution is removable with one
DELETE.** The Integrations panel on /progress exposes this:

- **Pause** — `integration_settings.enabled=false` stops every sync path (cron,
  visit-triggered `after()` staleness sync, manual button) without touching data.
- **Remove data** — deletes `observations WHERE source=?` and the sync snapshot.
  Mastery/coverage recompute immediately. Item-detail mapping ids are inert and kept.
- Pause + Remove = integration fully gone; Enable + Sync = fully back.

## Setup

1. Copy the API key from bunpro.jp/settings/api into `BUNPRO_API_KEY` (.env.local and
   Vercel Production env).
2. First sync via the Integrations panel on /progress (the visit-triggered background
   sync only refreshes an existing snapshot; the first run is deliberately manual so
   the mapping summary is visible).
3. Daily cron backstop shares the WaniKani cron route (`/api/cron/wanikani`).
