# Plan 01 — Reference library: JLPT N4/N5 vocab + kanji lists

## Goal

Get the published N4/N5 word and kanji lists into the app as first-class data:
browsable/searchable "dictionary" pages, served roughly the way nihongoichiban presents
them. This table is deliberately more than a UI feature — it becomes:

- the **canonical node set** for the knowledge graph (Plan 02),
- the **allow-list** for the workshop v1.5 vocabulary-validation loop (already sketched in
  `SETUP.md`: tokenize output → check every lemma against the N4 list → re-prompt),
- the **source list** for the vocab sprint (Plan 03).

## Source data

Primary (the lists Eric pointed at):

| List | URL | Size | Format |
|---|---|---|---|
| N5 vocab | https://nihongoichiban.com/2011/04/30/complete-list-of-vocabulary-for-the-jlpt-n5/ | ~700 | HTML tables: kanji / furigana / romaji / meaning |
| N4 vocab | https://nihongoichiban.com/2012/06/15/complete-list-of-vocabulary-for-the-jlpt-n4/ | ~1,500 (cumulative — includes N5 words) | same 4 columns, tables per hiragana row |
| N5 kanji | https://nihongoichiban.com/2011/04/10/complete-list-of-kanji-for-jlpt-n5/ | 103 | table: unicode / kanji / onyomi / kunyomi / meaning |
| N4 kanji | https://nihongoichiban.com/2011/05/22/complete-list-of-kanji-for-the-jlpt-n4/ | 181 additional | same |

Cross-check / enrichment source: **github.com/elzup/jlpt-word-list** (community JSON
reconstruction of the same JLPT lists, already vetted in the research doc). Use it to
sanity-check the scrape (entry counts, missing readings) and as a tiebreaker on typos.
There are no official JLPT lists post-2010; these community lists are the standard.

Licensing: fine for a personal tool; the site's own kanji ebook is explicitly "no
copyright". Don't republish the merged dataset beyond this app.

## Ingestion approach

One-time **scrape script → seed JSON files checked into the repo → idempotent DB seed**.
Checked-in JSON (e.g. `data/seed/vocab-n5.json`, `vocab-n4.json`, `kanji-n5.json`,
`kanji-n4.json`) means the scrape never has to run again, the data is reviewable in PRs,
and re-seeding a fresh DB is deterministic.

- Scrape script: `scripts/scrape-lists.ts` (run manually once, `tsx`/`node --experimental-strip-types`;
  plain fetch + cheerio or regex over the tables — no new runtime deps in the app itself).
- Seed script: `scripts/seed-items.ts` + `npm run db:seed` — upsert by `(kind, headword, reading)`.
- **Dedupe rule:** the N4 vocab list is cumulative. Tag each word with the *lowest* level it
  appears in (会う → N5, 挨拶 → N4). Report counts after dedupe (expect ~700 N5 + ~800
  N4-only ≈ 1,500 total, matching the research doc's numbers).

## Schema (Drizzle, `lib/db/schema.ts`)

One polymorphic `items` table rather than separate vocab/kanji tables — Plan 02's edges and
observations tables need a single foreign-key target, and the typed-column cost is small:

```ts
export const items = pgTable("items", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").$type<"vocab" | "kanji" | "grammar">().notNull(),
  level: text("level").$type<JlptLevel>().notNull(),   // lowest level where required
  headword: text("headword").notNull(),   // 会う / 安 / 〜てもいい
  reading: text("reading"),               // あう (kana); null for grammar
  romaji: text("romaji"),
  meaning: text("meaning").notNull(),
  detail: jsonb("detail").$type<ItemDetail>(),  // kanji: {onyomi, kunyomi, unicode}; vocab: {pos?}
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("items_identity").on(t.kind, t.headword, t.reading)]);
```

Part-of-speech for vocab (`detail.pos`) is worth capturing during ingestion where cheap —
nihongoichiban has separate N4 verb / i-adj / na-adj lists that can be joined against, and
Plan 03 wants a verbs-first ordering. Don't block on full POS coverage.

Also compute the first **edge type** here since it's free: `vocab contains kanji`
(match each kanji character in a vocab headword against the kanji items). Either add the
`item_edges` table now (schema in Plan 02) or compute on the fly in the kanji detail page;
recommend adding the table now so Plan 02 starts with a populated graph.

## UI — `/library`

- **Vocab tab**: level filter (N5 / N4 / all), search box matching kanji, kana, romaji, and
  English; grouped by gojūon row (あ, か, さ…) like the source site. Server component with
  client-side filtering over the full list (~1,500 rows is nothing; ship it all, filter in
  the client for instant search).
- **Kanji tab**: grid of cards (kanji, level badge — reuse `app/workshop/level-badge.tsx`),
  click → detail panel/page: onyomi, kunyomi, meaning, and "N4/N5 words using this kanji"
  via the contains-edge.
- Nav: add "Library" to `app/nav.tsx`.
- Leave a visual slot on each row/card for a future mastery badge (Plan 02) — even just a
  gray dot placeholder — so the graph work later doesn't need a redesign.

## Non-goals (this plan)

- Grammar-point list (curated in Plan 02 — different sourcing problem).
- Any progress/mastery display logic beyond the placeholder slot.
- SRS/flashcards — the library is a reference + dataset, not a study mode.

## Verification

- Seed counts logged and compared against expected (103 / 181 kanji, ~700/~800 vocab split).
- Spot-check 10 random entries against the live site.
- `npx tsc --noEmit` + `npm run lint`; library page renders with DB seeded and search works
  for kana ("あう"), romaji ("au"), English ("meet"), kanji ("会").
