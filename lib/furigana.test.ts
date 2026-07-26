import { test } from "node:test";
import assert from "node:assert/strict";
import { alignFurigana } from "./furigana.ts";

test("annotates kanji runs, leaves kana anchors bare", () => {
  assert.deepEqual(
    alignFurigana("日本に行ったことがありません。", "にほんにいったことがありません。"),
    [
      { text: "日本", ruby: "にほん" },
      { text: "に" },
      { text: "行", ruby: "い" },
      { text: "ったことがありません。" },
    ],
  );
});

test("repeated anchor kana between kanji runs splits correctly", () => {
  assert.deepEqual(alignFurigana("一つ一つ", "ひとつひとつ"), [
    { text: "一", ruby: "ひと" },
    { text: "つ" },
    { text: "一", ruby: "ひと" },
    { text: "つ" },
  ]);
});

test("katakana words pass through as anchors", () => {
  assert.deepEqual(
    alignFurigana("コーヒーを飲みます", "コーヒーをのみます"),
    [
      { text: "コーヒーを" },
      { text: "飲", ruby: "の" },
      { text: "みます" },
    ],
  );
});

test("sentence starting and ending with kanji", () => {
  assert.deepEqual(alignFurigana("毎朝六時に起床", "まいあさろくじにきしょう"), [
    { text: "毎朝六時", ruby: "まいあさろくじ" },
    { text: "に" },
    { text: "起床", ruby: "きしょう" },
  ]);
});

test("repetition mark 々 counts as kanji", () => {
  assert.deepEqual(alignFurigana("人々が", "ひとびとが"), [
    { text: "人々", ruby: "ひとびと" },
    { text: "が" },
  ]);
});

test("all-kana sentence needs no annotation", () => {
  assert.deepEqual(
    alignFurigana("じゅうにがつににほんへいきます。", "じゅうにがつににほんへいきます。"),
    [{ text: "じゅうにがつににほんへいきます。" }],
  );
});

test("digits take ruby like kanji (full-width and ascii)", () => {
  assert.deepEqual(
    alignFurigana("２月に始めました", "にがつにはじめました"),
    [
      { text: "２月", ruby: "にがつ" },
      { text: "に" },
      { text: "始", ruby: "はじ" },
      { text: "めました" },
    ],
  );
  assert.deepEqual(alignFurigana("12月です", "じゅうにがつです"), [
    { text: "12月", ruby: "じゅうにがつ" },
    { text: "です" },
  ]);
});

test("digit run may read shorter than its character count", () => {
  assert.deepEqual(alignFurigana("1000円を払う", "せんえんをはらう"), [
    { text: "1000円", ruby: "せんえん" },
    { text: "を" },
    { text: "払", ruby: "はら" },
    { text: "う" },
  ]);
});

test("anchor kana inside a neighboring reading doesn't shift the split", () => {
  // The に after ２月 also appears at the start of にほんご — the plausible-length
  // scoring must keep ２月→にがつ and 日本語→にほんご.
  const segs = alignFurigana(
    "２月に日本語の勉強を始めました",
    "にがつににほんごのべんきょうをはじめました",
  );
  assert.deepEqual(segs?.slice(0, 3), [
    { text: "２月", ruby: "にがつ" },
    { text: "に" },
    { text: "日本語", ruby: "にほんご" },
  ]);
});

test("mismatched reading returns null", () => {
  assert.equal(alignFurigana("日本に行きます", "ぜんぜんちがうよみかた"), null);
});

test("empty reading with kanji present returns null", () => {
  assert.equal(alignFurigana("日本", ""), null);
});

test("punctuation and ascii act as anchors", () => {
  assert.deepEqual(
    alignFurigana("十二月に日本へ旅行に行きます。", "じゅうにがつににほんへりょこうにいきます。"),
    [
      { text: "十二月", ruby: "じゅうにがつ" },
      { text: "に" },
      { text: "日本", ruby: "にほん" },
      { text: "へ" },
      { text: "旅行", ruby: "りょこう" },
      { text: "に" },
      { text: "行", ruby: "い" },
      { text: "きます。" },
    ],
  );
});
