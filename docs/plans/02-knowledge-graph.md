# Plan 02 — Knowledge graph / progress brain

## Assessment: is a knowledge graph worth it?

**Yes — as a data model, not as a technology.** The useful idea is: one canonical set of
nodes (every N5/N4 vocab word, kanji, and grammar point), typed edges between them, and an
**evidence ledger** where every study signal (WaniKani SRS state, practice-question
results, workshop sentences, sprint recall) attaches to nodes. Mastery and coverage are
then *derived views* over evidence.

What it should **not** be: a graph database. Neo4j/graph infra buys nothing at this scale
(~2k nodes, a few thousand edges, single user) and costs a second datastore. Postgres +
two tables (`items`, `item_edges`) *is* the graph. If graph-shaped queries ever get gnarly,
that's a query-layer problem to solve then, not a reason to pick infra now.

Per the July 10 research doc, this is also the genuinely empty niche: nothing on the market
computes cross-tool JLPT readiness from the learner's actual data, and the nearest prior
art (Nihongo Stats — github.com/ranger-ross/nihongo-stats — study before building the sync)
only aggregates dashboards, it has no item-level model and no practice-test loop. The
**practice-problem grading loop is the differentiator** and the thing Eric has already seen
work ad-hoc with LLMs ("you're solid on X grammar, struggling with Y").

## Model

Nodes: `items` from Plan 01, plus **grammar** items added here.

```ts
export const itemEdges = pgTable("item_edges", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromId: uuid("from_id").references(() => items.id).notNull(),
  toId: uuid("to_id").references(() => items.id).notNull(),
  relation: text("relation").$type<"contains_kanji" | "related" | "prerequisite">().notNull(),
});

// The evidence ledger. Append-only; everything else is derived.
export const observations = pgTable("observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").references(() => items.id).notNull(),
  source: text("source").$type<"wanikani" | "practice" | "workshop" | "sprint" | "anki" | "manual">().notNull(),
  kind: text("kind").$type<"answer" | "srs_state" | "exposure">().notNull(),
  correct: boolean("correct"),          // for answer
  srsStage: integer("srs_stage"),       // for srs_state (WK 0–9)
  meta: jsonb("meta"),                  // e.g. {questionId}, {wkSubjectId, percentageCorrect}
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});

// Materialized per-item score, recomputed on write (cheap at this scale).
export const itemMastery = pgTable("item_mastery", {
  itemId: uuid("item_id").references(() => items.id).primaryKey(),
  score: doublePrecision("score").notNull(),        // 0..1
  status: text("status").$type<"unseen" | "learning" | "solid" | "mastered">().notNull(),
  observationCount: integer("observation_count").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
```

**Mastery v1 — keep it dumb and transparent:** per item, take recency-decayed answer
accuracy (half-life ~30 days) blended with the best SRS signal (WK stage/9). Thresholds:
unseen = no observations; learning < 0.6; solid 0.6–0.85; mastered > 0.85. Tune later with
real data; resist FSRS/IRT until the dashboard proves misleading. Single-user app → no
`userId` columns yet; note it in schema comments so it's a known migration, not a surprise.

## Phases (each independently shippable)

### 2a — Graph skeleton + grammar nodes + backfill

- Add the three tables; seed **grammar items** (~200 total: N5 ~80, N4 ~120). No official
  list exists — curate a seed JSON with Claude cross-checked against the Genki I/II table of
  contents, patterns as headwords (〜てもいい), one-line meaning. Review by hand once; it's
  the graph's weakest data and worth an hour of eyeballing.
- Backfill observations from data the app **already has**: every saved workshop sentence
  stores `vocab[]` and `grammar[]` (see `sentences` table) → `exposure` observations,
  matched to items by word+reading.
- Recompute-mastery function + the mastery badge in the library UI (fills Plan 01's slot).

### 2b — Practice-problem loop (the core feature)

Sources on hand: **Shin Nihongo 500 Mon N4–N5** (ISBN 9784872179408 — 4 weeks × 7 days ×
~15 questions/day, each day mixing kanji/vocab/grammar, answers with explanations on the
following page) plus **old JLPT exams / official practice workbooks** (2012 + 2018 PDFs+MP3
per level, jlpt.jp/e/samples — the only real past items).

Flow:
1. `/practice` page: create a session (source + label, e.g. "500問 Week 2 Day 3"), upload
   photo(s) of the completed page — user's pencil marks visible.
2. Server action → Claude vision (existing `lib/anthropic.ts`, structured output with zod,
   same pattern as the workshop): extract each question (stem, choices, correct answer if
   the answer page is included, the user's marked answer), grade, and **tag each question
   with the item(s) it tests** — vocab word, kanji, and/or grammar pattern, matched against
   the items table (pass the candidate list for the level in the prompt or resolve
   fuzzily server-side afterward; exact-match by headword first, Claude only for ties).
3. Persist: `practiceSessions`, `practiceQuestions` (stem, choices jsonb, correctChoice,
   userChoice, isCorrect, explanation), `questionItems` join (questionId, itemId, role
   tested|context). Write one `answer` observation per tested item. Store images
   (Vercel Blob in prod / `public/practice/` gitignored locally, mirroring the clips pattern).
4. Session report: score, per-question review with explanations, and the rolling weakness
   view: "grammar points ranked by decayed accuracy, minimum 3 observations" — this is the
   "you're great at ~てもいい, weak on ~ておく" output that motivated the whole idea.

Design decision to honor: extraction quality varies with photo quality — always show the
extracted questions for a quick confirm/edit step *before* committing observations. Bad
data in the evidence ledger is worse than a 10-second review step.

### 2c — WaniKani sync

- API v2, personal access token (env var), 60 req/min, revision `20170710`. Pull
  `/subjects` (once, cached — map WK subject → items by characters+reading, store
  `wkSubjectId` in `items.detail`), then `/assignments` + `/review_statistics` on each sync
  → `srs_state` observations (stage 0–9) and accuracy meta.
- Note: WK removed per-review history (Apr 2023) — aggregate stats only, which is fine for
  the mastery model.
- Trigger: manual "Sync now" button first; Vercel cron nightly once it's trusted. Expect
  imperfect coverage (WK's set ≠ JLPT lists); unmatched WK subjects are simply ignored,
  unmatched items just have no WK evidence.
- Later, same pattern: Renshuu API (verified live, gives per-level %), Bunpro (official API
  reportedly launched June 2026 — verify on their forums first), Anki via the existing
  anki-tools/AnkiConnect bridge (local-only, so lowest priority for the deployed app).

### 2d — Readiness dashboard

`/progress`: per level (N5/N4) × kind (vocab/kanji/grammar): coverage bars
(unseen/learning/solid/mastered), weakest-items list, observation volume over time, and a
countdown framing vs. **exam day Dec 6, 2026** (register ~mid-Aug, aatj.org/jlpt-us).
Keep it honest: show observation counts next to scores so thin evidence is visible.

## Verification

- 2a: mastery recompute is deterministic on a fixture set; library badges render.
- 2b: run a real completed page from the 500問 book through the loop end-to-end; check
  extraction accuracy, correct tagging of ≥90% of questions, weakness view updates.
- 2c: sync against Eric's real WK account; spot-check 10 item mappings.
