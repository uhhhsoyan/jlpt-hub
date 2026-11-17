import { test } from "node:test";
import assert from "node:assert/strict";
import { createItemIndex, findInIndex, matchTag, suggestItems, tokenizeQuery, topicItemIds, type IndexRow } from "./item-match.ts";

const rows: IndexRow[] = [
  { id: "yori", kind: "grammar", level: "N5", headword: "〜より", reading: "", meaning: "comparison: more than ~", aliases: ["より"] },
  { id: "nohou", kind: "grammar", level: "N5", headword: "〜のほうが", reading: "", meaning: "A is more ~ than B", aliases: ["のほう", "のほうが", "のほうを"] },
  { id: "hodo", kind: "grammar", level: "N5", headword: "〜ほど〜ない", reading: "", meaning: "not as ~ as", aliases: ["ほど", "ほど〜ない"] },
  { id: "hodo-v", kind: "vocab", level: "N4", headword: "ほど", reading: "ほど", meaning: "extent, degree", aliases: null },
  { id: "ichiban-g", kind: "grammar", level: "N5", headword: "〜が一番", reading: "", meaning: "superlative", aliases: ["一番", "いちばん", "がいちばん"] },
  { id: "ichiban-v", kind: "vocab", level: "N5", headword: "一番", reading: "いちばん", meaning: "number one, the most", aliases: null },
  { id: "made", kind: "grammar", level: "N5", headword: "まで", reading: "", meaning: "until", aliases: null },
  { id: "tokoro-v", kind: "vocab", level: "N5", headword: "所", reading: "ところ", meaning: "place", aliases: null },
  { id: "ru-tokoro", kind: "grammar", level: "N4", headword: "〜るところだ", reading: "", meaning: "about to do ~", aliases: null },
  { id: "dochira-v", kind: "vocab", level: "N5", headword: "どちら", reading: "どちら", meaning: "which (of two)", aliases: null },
  { id: "dochira-g", kind: "grammar", level: "N5", headword: "〜と〜とどちら", reading: "", meaning: "which of A and B", aliases: ["とどちら", "どちらが"] },
  { id: "kutsu", kind: "vocab", level: "N5", headword: "靴", reading: "くつ", meaning: "shoes", aliases: null },
  { id: "kutsushita", kind: "vocab", level: "N5", headword: "靴下", reading: "くつした", meaning: "socks", aliases: null },
  { id: "kiru", kind: "kanji", level: "N4", headword: "切", reading: "", meaning: "cut", aliases: null },
];
const index = createItemIndex(rows);

test("exact headword and tilde-insensitive grammar match within kind", () => {
  assert.equal(matchTag(index, { kind: "grammar", text: "〜より" }), "yori");
  assert.equal(matchTag(index, { kind: "grammar", text: "より" }), "yori");
  assert.equal(matchTag(index, { kind: "grammar", text: "〜のほうが" }), "nohou");
});

test("aliases resolve loosely spelled patterns", () => {
  assert.equal(matchTag(index, { kind: "grammar", text: "〜ほど" }), "hodo");
  assert.equal(matchTag(index, { kind: "grammar", text: "ほど〜ない" }), "hodo");
  assert.equal(matchTag(index, { kind: "grammar", text: "〜ほど 〜ない" }), "hodo");
  assert.equal(matchTag(index, { kind: "grammar", text: "のほう" }), "nohou");
});

test("the tag's own kind wins when both kinds have a hit", () => {
  // grammar alias "一番" beats the vocab headword 一番 for a grammar tag, and vice versa.
  assert.equal(matchTag(index, { kind: "grammar", text: "一番" }), "ichiban-g");
  assert.equal(matchTag(index, { kind: "vocab", text: "一番" }), "ichiban-v");
  assert.equal(matchTag(index, { kind: "vocab", text: "いちばん" }), "ichiban-v");
});

test("falls back across kinds when the tagged kind has nothing", () => {
  // どちら logged as grammar: no grammar headword/alias says exactly どちら, vocab does.
  assert.equal(matchTag(index, { kind: "grammar", text: "どちら" }), "dochira-v");
  assert.equal(matchTag(index, { kind: "vocab", text: "切" }), "kiru");
});

test("kana reading matches vocab, and ambiguity stays unresolved", () => {
  assert.equal(matchTag(index, { kind: "vocab", text: "くつ" }), "kutsu");
  assert.equal(matchTag(index, { kind: "vocab", text: "紅茶" }), null);
  assert.equal(matchTag(index, { kind: "grammar", text: "" }), null);
});

test("suggestions rank exact and prefix hits first, same kind preferred", () => {
  const s = suggestItems(index, "ほど", { kind: "grammar" });
  assert.deepEqual(
    s.map((x) => x.id),
    ["hodo", "hodo-v"],
  );
  const kutsu = suggestItems(index, "くつ", { kind: "vocab", limit: 3 }).map((x) => x.id);
  assert.deepEqual(kutsu, ["kutsu", "kutsushita"]);
  assert.deepEqual(suggestItems(index, "shoes").map((x) => x.id), ["kutsu"]);
  assert.deepEqual(suggestItems(index, "   "), []);
});

test("an item that is only a prefix of the query ranks last and is labelled prefix-only", () => {
  // まで is a different item from 〜までに; it is still offered, but marked so it is not taken for a hit.
  const madeni = suggestItems(index, "〜までに", { kind: "grammar" });
  assert.deepEqual(
    madeni.map((x) => [x.id, x.match]),
    [["made", "prefix-only"]],
  );
  // 〜るところだ contains ところだ; vocab 所 (reading ところ) is only a prefix of it and the wrong kind.
  const tokoro = suggestItems(index, "〜ところだ", { kind: "grammar" });
  assert.deepEqual(
    tokoro.map((x) => [x.id, x.match]),
    [
      ["ru-tokoro", "contains"],
      ["tokoro-v", "prefix-only"],
    ],
  );
  assert.equal(suggestItems(index, "ほど", { kind: "grammar" })[0]?.match, "exact");
});

// Glosses copied from the live library, where these three queries used to return nothing.
const meaningRows: IndexRow[] = [
  { id: "te-riyuu", kind: "grammar", level: "N4", headword: "〜て（理由）", reading: "", meaning: "て-form giving a cause: ~ and so / because ~ (result is not a request or volition)", aliases: ["て（理由）", "て（原因）", "〜て（原因）", "〜くて（理由）"] },
  { id: "te-shudan", kind: "grammar", level: "N4", headword: "〜て（手段）", reading: "", meaning: "て-form giving the means: by ~ing", aliases: null },
  { id: "te-junjo", kind: "grammar", level: "N5", headword: "〜て（順序）", reading: "", meaning: "て-form joining actions in sequence: ~ and then ~", aliases: null },
  { id: "nakute", kind: "grammar", level: "N4", headword: "〜なくて", reading: "", meaning: "negative て-form joining clauses: not ~ and / because not ~", aliases: null },
  { id: "kara-riyuu", kind: "grammar", level: "N5", headword: "から（理由）", reading: "", meaning: "because, reason (conjunction after plain/polite form)", aliases: null },
  { id: "tame-riyuu", kind: "grammar", level: "N4", headword: "〜ため（に）［理由］", reading: "", meaning: "reason/cause: because of ~", aliases: null },
  { id: "sorede", kind: "vocab", level: "N4", headword: "それで", reading: "それで", meaning: "because of that", aliases: null },
  { id: "riyuu-v", kind: "vocab", level: "N4", headword: "理由", reading: "りゆう", meaning: "reason", aliases: null },
  { id: "wake-v", kind: "vocab", level: "N4", headword: "訳", reading: "わけ", meaning: "meaning, reason", aliases: null },
  { id: "te-v", kind: "vocab", level: "N5", headword: "手", reading: "て", meaning: "hand", aliases: null },
  { id: "nakereba", kind: "grammar", level: "N4", headword: "〜なければならない", reading: "", meaning: "obligation: must do ~", aliases: null },
  { id: "tewaikenai", kind: "grammar", level: "N4", headword: "〜てはいけない", reading: "", meaning: "prohibition: must not do ~", aliases: null },
  { id: "iru-need", kind: "vocab", level: "N4", headword: "いる", reading: "いる", meaning: "need, must have, be required", aliases: null },
  { id: "motsu", kind: "vocab", level: "N5", headword: "持つ", reading: "もつ", meaning: "to have, to own", aliases: null },
  { id: "yuu-k", kind: "kanji", level: "N4", headword: "有", reading: "", meaning: "to exist, to be, to have", aliases: null },
  { id: "nakutemoii", kind: "grammar", level: "N4", headword: "〜なくてもいい", reading: "", meaning: "no obligation: don't have to do ~", aliases: null },
  { id: "nakya", kind: "grammar", level: "N4", headword: "〜なきゃ（いけない）", reading: "", meaning: "colloquial contraction: have to, gotta do ~", aliases: null },
  { id: "takotoga", kind: "grammar", level: "N5", headword: "〜たことがある", reading: "", meaning: "experience: have done ~ before", aliases: null },
  { id: "temorau", kind: "grammar", level: "N4", headword: "〜てもらう", reading: "", meaning: "have someone do a favor for me, receive the favor", aliases: null },
  { id: "to-jouken", kind: "grammar", level: "N4", headword: "〜と（条件）", reading: "", meaning: "conditional: if/when ~, always leads to a natural result", aliases: null },
  { id: "ba-jouken", kind: "grammar", level: "N4", headword: "〜ば（条件）", reading: "", meaning: "conditional: if ~ (hypothetical condition)", aliases: null },
  { id: "tara-jouken", kind: "grammar", level: "N4", headword: "〜たら（条件）", reading: "", meaning: "conditional: if/when ~ (sequential, specific occasion)", aliases: null },
  { id: "nara-jouken", kind: "grammar", level: "N4", headword: "〜なら（条件）", reading: "", meaning: "conditional: if it's the case that ~", aliases: null },
  { id: "to-particle", kind: "grammar", level: "N5", headword: "と", reading: "", meaning: "particle: 'and' (exhaustive listing) or 'with' (accompaniment)", aliases: null },
  { id: "tokei", kind: "vocab", level: "N5", headword: "時計", reading: "とけい", meaning: "watch, clock", aliases: null },
  { id: "kutsu2", kind: "vocab", level: "N5", headword: "靴", reading: "くつ", meaning: "shoes", aliases: null },
  { id: "geta", kind: "vocab", level: "N4", headword: "下駄", reading: "げた", meaning: "wooden shoe", aliases: null },
  { id: "atarashii", kind: "vocab", level: "N5", headword: "新しい", reading: "あたらしい", meaning: "new", aliases: null },
  { id: "to-door", kind: "vocab", level: "N5", headword: "戸", reading: "と", meaning: "door", aliases: null },
  { id: "ocha", kind: "vocab", level: "N5", headword: "お茶", reading: "おちゃ", meaning: "tea, green tea", aliases: null },
];
const meaningIndex = createItemIndex(meaningRows);
const ids = (q: string, opts: { kind?: "vocab" | "kanji" | "grammar"; limit?: number } = {}) =>
  suggestItems(meaningIndex, q, { limit: 8, ...opts }).map((s) => s.id);

test("tokenizeQuery: splits on commas and spaces, drops stopwords and one-letter words, maps romaji form names", () => {
  assert.deepEqual(
    tokenizeQuery("because, reason te-form").map((t) => [t.text, t.form]),
    [
      ["because", null],
      ["reason", null],
      ["te-form", "て"],
    ],
  );
  assert.deepEqual(
    tokenizeQuery("must, have to").map((t) => t.text),
    ["must", "have"],
  );
  assert.deepEqual(
    tokenizeQuery("conditional と").map((t) => [t.text, t.form]),
    [
      ["conditional", null],
      ["と", "と"],
    ],
  );
  assert.deepEqual(
    tokenizeQuery("Te form, a 'reason'!").map((t) => t.text),
    ["te-form", "reason"],
  );
  assert.deepEqual(tokenizeQuery("the a of to"), []);
});

test("meaning: 'because, reason te-form' finds the て reason sense first", () => {
  const got = suggestItems(meaningIndex, "because, reason te-form", { limit: 8 });
  assert.equal(got[0]?.id, "te-riyuu");
  assert.equal(got[0]?.match, "meaning");
  // The other reason patterns cover two of the three words too; they follow.
  assert.ok(got.some((s) => s.id === "kara-riyuu"));
  assert.ok(got.some((s) => s.id === "tame-riyuu"));
  // One word of three is not enough: the other て senses, the vocab 手 (read て) and 理由 stay out.
  for (const id of ["te-shudan", "te-junjo", "te-v", "riyuu-v", "sorede"]) assert.ok(!got.some((s) => s.id === id), id);
});

test("meaning: 'must, have to' finds 〜なければならない without the 'have' coincidences", () => {
  const got = ids("must, have to");
  assert.ok(got.includes("nakereba"));
  // いる "need, must have" covers both words, so it may lead; the rest must be the "must" items.
  assert.deepEqual([...got].sort(), ["iru-need", "nakereba", "tewaikenai"]);
  for (const id of ["motsu", "yuu-k", "takotoga", "temorau"]) assert.ok(!got.includes(id), id);
});

test("meaning: a Japanese word in a mixed query matches forms, so 'conditional と' ranks 〜と（条件） first", () => {
  const got = suggestItems(meaningIndex, "conditional と", { limit: 8 });
  assert.equal(got[0]?.id, "to-jouken");
  assert.equal(got[0]?.match, "meaning");
  // と alone is not a conditional; wherever it lands, it is not first.
  assert.notEqual(got.findIndex((s) => s.id === "to-particle"), 0);
  // 時計 (reading とけい) only starts with と, and 戸 is merely read と: a single kana in a
  // mixed query is matched against headwords and aliases, not stretched over readings.
  assert.ok(!got.some((s) => s.id === "tokei"));
  assert.ok(!got.some((s) => s.id === "to-door"));
});

test("meaning: whole words only, plural tolerated, and nothing for unknown words", () => {
  assert.deepEqual([...ids("shoe")].sort(), ["geta", "kutsu2"]);
  assert.deepEqual([...ids("shoes")].sort(), ["geta", "kutsu2"]);
  // A plural ending is only stripped while four letters remain.
  assert.deepEqual(ids("news"), []);
  // "hand" must not be found by "han"; one-letter and stopword-only queries find nothing.
  assert.deepEqual(ids("han"), []);
  assert.deepEqual(ids("an"), []);
  assert.deepEqual(ids("xyzzy plugh"), []);
  // An unknown word does not sink a real one.
  assert.deepEqual([...ids("xyzzy shoes")].sort(), ["geta", "kutsu2"]);
  // Single word: every gloss carrying it, as before.
  assert.deepEqual([...ids("conditional")].sort(), ["ba-jouken", "nara-jouken", "tara-jouken", "to-jouken"]);
});

test("meaning hits stay below form hits, and pure-Japanese queries skip the word pass", () => {
  // と is a literal headword (and 戸's reading): exact; 〜と（条件） is と only once the sense label is dropped.
  const to = suggestItems(meaningIndex, "と", { limit: 3 }).map((s) => [s.id, s.match]);
  assert.deepEqual(to.slice(0, 2).map(([, m]) => m), ["exact", "exact"]);
  assert.ok(to.slice(0, 2).some(([id]) => id === "to-particle"));
  assert.deepEqual(to[2], ["to-jouken", "exact-loose"]);
  // A Japanese query with spaces is still one form, not two words.
  assert.deepEqual(ids("条件 と"), []);
});

test("exact-headword ranking: the literal headword beats a loose-key match", () => {
  const got = suggestItems(meaningIndex, "〜と（条件）", { kind: "grammar", limit: 2 });
  assert.deepEqual(
    got.map((s) => [s.id, s.match]),
    [
      ["to-jouken", "exact"],
      ["to-particle", "exact-loose"],
    ],
  );
  // Tildes, spacing and ASCII parentheses are still the same literal form.
  assert.equal(suggestItems(meaningIndex, "と(条件)", { limit: 1 })[0]?.match, "exact");
  assert.equal(suggestItems(meaningIndex, "なければならない", { limit: 1 })[0]?.match, "exact");
  // A different sense label is only loose: て（理由） is literal for one item, loose for the others.
  const te = suggestItems(meaningIndex, "て（理由）", { limit: 5 }).map((s) => [s.id, s.match]);
  assert.deepEqual(te[0], ["te-riyuu", "exact"]);
  assert.ok(te.some(([id, m]) => id === "te-shudan" && m === "exact-loose"));
  // matchTag resolution is unchanged by the new label.
  assert.equal(matchTag(meaningIndex, { kind: "grammar", text: "〜と（条件）" }), "to-jouken");
});

test("topicItemIds: same form, every sense, and grammar built on the topic, never vocab that merely starts with it", () => {
  const rows: IndexRow[] = [
    { id: "hazu-g", kind: "grammar", level: "N4", headword: "〜はずだ", reading: "", meaning: "expectation: should be ~", aliases: null },
    { id: "hazu-v", kind: "vocab", level: "N4", headword: "はず", reading: "はず", meaning: "it should be so", aliases: null },
    { id: "hazukashii", kind: "vocab", level: "N4", headword: "恥ずかしい", reading: "はずかしい", meaning: "embarrassed", aliases: null },
    { id: "kara-r", kind: "grammar", level: "N5", headword: "から（理由）", reading: "", meaning: "because", aliases: null },
    { id: "kara-k", kind: "grammar", level: "N5", headword: "から（起点）", reading: "", meaning: "from", aliases: null },
    { id: "karada", kind: "vocab", level: "N5", headword: "体", reading: "からだ", meaning: "body", aliases: null },
    { id: "toki", kind: "grammar", level: "N5", headword: "とき（時）", reading: "", meaning: "when", aliases: null },
    { id: "to-p", kind: "grammar", level: "N5", headword: "と", reading: "", meaning: "and", aliases: null },
  ];
  const idx = createItemIndex(rows);
  assert.deepEqual([...topicItemIds(idx, "はず")].sort(), ["hazu-g", "hazu-v"]);
  assert.deepEqual([...topicItemIds(idx, "から")].sort(), ["kara-k", "kara-r"]);
  // One kana is too short to stretch over longer patterns (と is not about とき).
  assert.deepEqual(topicItemIds(idx, "と"), ["to-p"]);
  assert.deepEqual(topicItemIds(idx, "particles"), []);
  assert.deepEqual(topicItemIds(idx, " "), []);
});

test("findInIndex: resolves says whether the text works as a tag as-is", () => {
  const hit = findInIndex(meaningIndex, "〜と（条件）", { limit: 2 });
  assert.deepEqual(hit.resolves, { id: "to-jouken", headword: "〜と（条件）" });
  assert.equal(hit.items[0]?.id, "to-jouken");
  const words = findInIndex(meaningIndex, "conditional と", { limit: 2 });
  assert.equal(words.resolves, null);
  assert.equal(words.items[0]?.id, "to-jouken");
  // With a kind, the tag ladder for that kind decides (the grammar alias wins for a grammar tag).
  assert.equal(findInIndex(index, "一番", { kind: "grammar" }).resolves?.id, "ichiban-g");
  assert.equal(findInIndex(index, "一番", { kind: "vocab" }).resolves?.id, "ichiban-v");
  assert.equal(findInIndex(index, "紅茶").resolves, null);
});
