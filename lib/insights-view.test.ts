import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_INSIGHTS_QUERY,
  assembleInsights,
  countTags,
  groupTags,
  insightsHref,
  itemKey,
  parseInsightsQuery,
  parseLessonTag,
  sheetGroups,
  topItems,
  withTag,
  withoutTag,
  type InsightRecord,
  type InsightsQuery,
  type ItemInfo,
} from "./insights-view.ts";

const at = (d: number, h = 20) => new Date(Date.UTC(2026, 10, d, h));
const q = (patch: Partial<InsightsQuery>): InsightsQuery => ({ ...NO_INSIGHTS_QUERY, ...patch });

const ITEMS: ItemInfo[] = [
  { id: "hazu", kind: "grammar", headword: "〜はずだ", reading: "", meaning: "should (expectation)" },
  { id: "kamo", kind: "grammar", headword: "〜かもしれない", reading: "", meaning: "might" },
  { id: "you", kind: "grammar", headword: "〜ようだ", reading: "", meaning: "seems" },
  { id: "maniau", kind: "vocab", headword: "間に合う", reading: "まにあう", meaning: "to be in time" },
];

const ROWS: InsightRecord[] = [
  {
    id: "hazu-cue",
    text: "〜はずです is should of expectation, never of duty.",
    tags: ["shin-kanzen-master", "skm-l12", "test-strategy", "cue"],
    items: [
      { kind: "grammar", text: "〜はずだ", itemId: "hazu" },
      { kind: "grammar", text: "〜かもしれない", itemId: "kamo" },
    ],
    source: "claude-ai",
    createdAt: at(12, 18),
  },
  {
    id: "choose",
    text: "Choosing among はず / よう / かもしれない by how sure the speaker is.",
    tags: ["shin-kanzen-master", "skm-l12", "test-strategy", "grammar-sense"],
    items: [
      { kind: "grammar", text: "〜はずだ", itemId: "hazu" },
      { kind: "grammar", text: "〜ようだ", itemId: "you" },
      { kind: "grammar", text: "〜かもしれない", itemId: "kamo" },
    ],
    source: "claude-ai",
    createdAt: at(12, 19),
  },
  {
    id: "kamo-neg",
    text: "Thought かもしれない was always negative because it ends in ない.",
    tags: ["skm-l12", "Polarity", "cue"],
    items: [{ kind: "grammar", text: "かもしれない", itemId: "kamo" }],
    source: "claude-ai",
    createdAt: at(12, 17),
  },
  {
    id: "shy",
    text: "Read はずかしい as はず + かしい; it is one adjective, embarrassed.",
    tags: ["vocab", "misparse"],
    items: [{ kind: "vocab", text: "恥ずかしい", itemId: null }],
    source: "claude-code",
    createdAt: at(14),
  },
  {
    id: "unresolved-only",
    text: "なしで is the written way to say without.",
    tags: ["written-style", "skm-l2"],
    items: [
      { kind: "grammar", text: "〜なしで", itemId: null },
      { kind: "vocab", text: "関係", itemId: null },
    ],
    source: "claude-ai",
    createdAt: at(6),
  },
  {
    id: "unresolved-again",
    text: "Another なしで slip in a notice.",
    tags: ["skm-l10", "notices"],
    items: [{ kind: "grammar", text: "なしで", itemId: null }],
    source: "claude-ai",
    createdAt: at(7),
  },
  {
    id: "plan",
    text: "Study plan: review every graded question.",
    tags: [],
    items: [],
    source: "hub",
    createdAt: at(5),
  },
  {
    id: "vocab-dump",
    text: "間に合う is non-volitional.",
    tags: ["volitional-verbs", "SKM-L9"],
    items: [{ kind: "vocab", text: "間に合う", itemId: "maniau" }],
    source: "claude-ai",
    createdAt: at(10),
  },
];

const ids = (page: { cards: { id: string }[] }) => page.cards.map((c) => c.id);

// ---- URL state ----

test("parseInsightsQuery: repeated and comma-separated tags, dedupe case-insensitively, trims and defaults", () => {
  assert.deepEqual(parseInsightsQuery({}), NO_INSIGHTS_QUERY);
  const got = parseInsightsQuery({ q: "  はず ", tag: ["skm-l12,cue", "CUE", " "], item: "hazu", view: "sheet" });
  assert.deepEqual(got, { q: "はず", tags: ["skm-l12", "cue"], item: "hazu", view: "sheet" });
  assert.equal(parseInsightsQuery({ view: "grid", q: "   " }).view, "list");
  assert.equal(parseInsightsQuery({ q: "   " }).q, null);
});

test("insightsHref round-trips through parseInsightsQuery, defaults left out", () => {
  assert.equal(insightsHref(), "/insights");
  assert.equal(insightsHref(NO_INSIGHTS_QUERY), "/insights");
  const query = q({ q: "はず", tags: ["skm-l12", "a,b"], item: "〜はずだ", view: "sheet" });
  const href = insightsHref(query);
  const params = Object.fromEntries(
    [...new URLSearchParams(href.split("?")[1]).entries()].reduce((m, [k, v]) => m.set(k, [...(m.get(k) ?? []), v]), new Map<string, string[]>()),
  );
  // A tag holding a comma splits on the way back in: comma is the separator.
  assert.deepEqual(parseInsightsQuery(params), { ...query, tags: ["skm-l12", "a", "b"] });
});

test("withTag / withoutTag add once and remove case-insensitively", () => {
  const a = withTag(NO_INSIGHTS_QUERY, "cue");
  assert.deepEqual(a.tags, ["cue"]);
  assert.equal(withTag(a, "CUE"), a);
  assert.deepEqual(withoutTag(withTag(a, "polarity"), "Cue").tags, ["polarity"]);
});

// ---- Filtering ----

test("empty input: nothing to show, nothing to group", () => {
  const page = assembleInsights([], [], q({ q: "はず", tags: ["x"], item: "y", view: "sheet" }));
  assert.equal(page.total, 0);
  assert.deepEqual(page.cards, []);
  assert.deepEqual(page.tagGroups, { series: [], topics: [], more: [] });
  assert.deepEqual(page.itemIndex, []);
  assert.deepEqual(page.sheet, []);
  assert.deepEqual(assembleInsights([], [], NO_INSIGHTS_QUERY).sheet, null);
});

test("no filter: every insight, newest first", () => {
  const page = assembleInsights(ROWS, ITEMS, NO_INSIGHTS_QUERY);
  assert.deepEqual(ids(page), ["shy", "choose", "hazu-cue", "kamo-neg", "vocab-dump", "unresolved-again", "unresolved-only", "plan"]);
  assert.equal(page.total, ROWS.length);
  assert.ok(page.cards.every((c) => c.matched === undefined));
});

test("two tags AND together, case-insensitively", () => {
  assert.deepEqual(ids(assembleInsights(ROWS, ITEMS, q({ tags: ["skm-l12", "CUE"] }))), ["hazu-cue", "kamo-neg"]);
  assert.deepEqual(ids(assembleInsights(ROWS, ITEMS, q({ tags: ["skm-l12", "notices"] }))), []);
});

test("q ranks item and tag hits above text-only hits: はず finds 〜はずだ notes before はずかしい", () => {
  const page = assembleInsights(ROWS, ITEMS, q({ q: "はず" }), { topicItemIds: ["hazu"] });
  assert.deepEqual(
    page.cards.map((c) => [c.id, c.matched]),
    [
      ["choose", "item"],
      ["hazu-cue", "item"],
      ["shy", "text"],
    ],
  );
});

test("q matches item texts as logged (unresolved items) and partial tags", () => {
  assert.deepEqual(
    assembleInsights(ROWS, ITEMS, q({ q: "なしで" })).cards.map((c) => [c.id, c.matched]),
    [
      ["unresolved-again", "item"],
      ["unresolved-only", "item"],
    ],
  );
  // 3+ characters inside a tag is a tag hit; shorter fragments are not.
  assert.deepEqual(
    assembleInsights(ROWS, ITEMS, q({ q: "polar" })).cards.map((c) => [c.id, c.matched]),
    [["kamo-neg", "tag"]],
  );
  assert.deepEqual(ids(assembleInsights(ROWS, ITEMS, q({ q: "po" }))), []);
  // An item text that merely contains the query is a text hit.
  assert.deepEqual(
    assembleInsights(ROWS, ITEMS, q({ q: "恥" })).cards.map((c) => [c.id, c.matched]),
    [["shy", "text"]],
  );
});

test("tag + q + item combine (all must hold)", () => {
  const page = assembleInsights(ROWS, ITEMS, q({ q: "negative", tags: ["cue"], item: "kamo" }), { topicItemIds: [] });
  // hazu-cue is about kamo and tagged cue but never says "negative"; choose has no cue tag.
  assert.deepEqual(ids(page), ["kamo-neg"]);
  assert.deepEqual(page.activeItem, { param: "kamo", label: "〜かもしれない", meaning: "might", ids: ["kamo"] });
  assert.deepEqual(ids(assembleInsights(ROWS, ITEMS, q({ q: "はず", tags: ["skm-l12"], item: "you" }), { topicItemIds: ["hazu"] })), ["choose"]);
});

test("item filter by id, by headword text, and by an unresolved item's text", () => {
  assert.deepEqual(ids(assembleInsights(ROWS, ITEMS, q({ item: "kamo" }))), ["choose", "hazu-cue", "kamo-neg"]);
  // Text without the tilde reaches the linked notes through the headword.
  const byText = assembleInsights(ROWS, ITEMS, q({ item: "はずだ" }));
  assert.deepEqual(ids(byText), ["choose", "hazu-cue"]);
  assert.equal(byText.activeItem?.label, "〜はずだ");
  assert.deepEqual(byText.activeItem?.ids, ["hazu"]);
  // Unresolved: matched on the written form, tilde or not.
  const unresolved = assembleInsights(ROWS, ITEMS, q({ item: "〜なしで" }));
  assert.deepEqual(ids(unresolved), ["unresolved-again", "unresolved-only"]);
  assert.deepEqual(unresolved.activeItem, { param: "〜なしで", label: "〜なしで", meaning: null, ids: [] });
  assert.deepEqual(ids(assembleInsights(ROWS, ITEMS, q({ item: "nothing-like-this" }))), []);
});

test("an insight with unresolved items only: chips keep their text, no id, param is the text", () => {
  const card = assembleInsights(ROWS, ITEMS, NO_INSIGHTS_QUERY).cards.find((c) => c.id === "unresolved-only");
  assert.deepEqual(card?.items, [
    { text: "〜なしで", itemId: null, param: "〜なしで" },
    { text: "関係", itemId: null, param: "関係" },
  ]);
});

test("cards carry the journal day in the learner's zone and the source", () => {
  const late: InsightRecord = { ...ROWS[0], id: "late", createdAt: new Date("2026-11-13T04:00:00Z") };
  const page = assembleInsights([late], ITEMS, NO_INSIGHTS_QUERY);
  assert.equal(page.cards[0].day, "2026-11-12");
  assert.equal(page.cards[0].source, "claude-ai");
});

// ---- Tags ----

test("countTags merges case, counts an insight once per tag, keeps the commonest spelling", () => {
  const got = countTags([{ tags: ["Cue", "cue"] }, { tags: ["cue"] }, { tags: ["cue", " ", "polarity"] }, { tags: [] }]);
  assert.deepEqual(got, [
    { tag: "cue", n: 3 },
    { tag: "polarity", n: 1 },
  ]);
});

test("parseLessonTag: series + l/lesson + number; odd shapes are topics", () => {
  assert.deepEqual(parseLessonTag("skm-l12"), { series: "skm", lesson: 12 });
  assert.deepEqual(parseLessonTag("SKM_L3"), { series: "skm", lesson: 3 });
  assert.deepEqual(parseLessonTag("genki-lesson-4"), { series: "genki", lesson: 4 });
  assert.deepEqual(parseLessonTag("skm-l012"), { series: "skm", lesson: 12 });
  for (const odd of ["l12", "skml12", "mail2", "skm-l12-review", "kanji-事", "skm-l", "-l3", "500mon", ""]) {
    assert.equal(parseLessonTag(odd), null, odd);
  }
});

test("groupTags: lesson strips in lesson order (l2 before l10), topics by count with a tail", () => {
  const counts = [
    { tag: "skm-l10", n: 2 },
    { tag: "cue", n: 9 },
    { tag: "skm-l2", n: 1 },
    { tag: "genki-l3", n: 1 },
    { tag: "SKM-L9", n: 4 },
    { tag: "polarity", n: 3 },
    { tag: "kanji-事", n: 1 },
    { tag: "aspect", n: 3 },
  ];
  const g = groupTags(counts, 2);
  assert.deepEqual(
    g.series.map((s) => [s.label, s.lessons.map((l) => l.lesson), s.n]),
    [
      ["SKM", [2, 9, 10], 7],
      ["Genki", [3], 1],
    ],
  );
  assert.deepEqual(g.topics, [
    { tag: "cue", n: 9 },
    { tag: "aspect", n: 3 },
  ]);
  assert.deepEqual(g.more, [
    { tag: "polarity", n: 3 },
    { tag: "kanji-事", n: 1 },
  ]);
});

test("assembleInsights: tag navigator covers every insight regardless of filters", () => {
  const page = assembleInsights(ROWS, ITEMS, q({ tags: ["notices"] }));
  const skm = page.tagGroups.series.find((s) => s.series === "skm");
  assert.deepEqual(
    skm?.lessons.map((l) => [l.tag, l.n]),
    [
      ["skm-l2", 1],
      ["SKM-L9", 1],
      ["skm-l10", 1],
      ["skm-l12", 3],
    ],
  );
});

// ---- Item index ----

test("topItems: an item linked from several insights leads; unresolved texts merge by form; singletons left out", () => {
  const byId = new Map(ITEMS.map((i) => [i.id, i]));
  assert.deepEqual(topItems(ROWS, byId), [
    { param: "kamo", label: "〜かもしれない", reading: null, meaning: "might", linked: true, n: 3 },
    { param: "hazu", label: "〜はずだ", reading: null, meaning: "should (expectation)", linked: true, n: 2 },
    { param: "〜なしで", label: "〜なしで", reading: null, meaning: null, linked: false, n: 2 },
  ]);
  assert.equal(topItems(ROWS, byId, 1).length, 1);
});

// ---- Review sheet ----

test("sheetGroups: notes on the same item together under its headword; unlinked under first tag or General", () => {
  const page = assembleInsights(ROWS, ITEMS, q({ view: "sheet" }));
  const sheet = page.sheet ?? [];
  assert.deepEqual(
    sheet.map((g) => [g.kind, g.title, g.entries.map((e) => e.card.id)]),
    [
      // Every かもしれない note lands together: kamo is what most of the selection is about.
      ["item", "〜かもしれない", ["choose", "hazu-cue", "kamo-neg"]],
      ["item", "間に合う", ["vocab-dump"]],
      ["tag", "#vocab", ["shy"]],
      ["tag", "#skm-l10", ["unresolved-again"]],
      ["tag", "#written-style", ["unresolved-only"]],
      ["general", "General", ["plan"]],
    ],
  );
  const kamo = sheet[0];
  assert.equal(kamo.meaning, "might");
  assert.deepEqual(kamo.query, { item: "kamo" });
  assert.deepEqual(kamo.entries[0].also, ["〜はずだ", "〜ようだ"]);
  assert.equal(sheet[1].reading, "まにあう");
  assert.deepEqual(sheet[2].query, { tags: ["vocab"] });
  assert.equal(sheet.at(-1)?.query, null);
});

test("sheetGroups: a filtered selection regroups by what it is about", () => {
  // Filtered to はず, the shared notes go under 〜はずだ instead.
  const page = assembleInsights(ROWS, ITEMS, q({ item: "hazu", view: "sheet" }));
  assert.deepEqual(
    page.sheet?.map((g) => [g.title, g.entries.map((e) => e.card.id)]),
    [["〜はずだ", ["choose", "hazu-cue"]]],
  );
  assert.deepEqual(sheetGroups([], new Map()), []);
});

test("itemKey folds width, tildes, spacing and a trailing sense label", () => {
  assert.equal(itemKey("〜たら（条件）"), "たら");
  assert.equal(itemKey("～ほど 〜ない"), "ほどない");
  assert.equal(itemKey("ＡＢ"), "ab");
});
