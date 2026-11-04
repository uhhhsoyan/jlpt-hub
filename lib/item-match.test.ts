import { test } from "node:test";
import assert from "node:assert/strict";
import { createItemIndex, matchTag, suggestItems, type IndexRow } from "./item-match.ts";

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
