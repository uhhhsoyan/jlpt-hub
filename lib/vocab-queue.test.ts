import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideQueueLink,
  effectiveAsMet,
  exportFilename,
  matchQueueItem,
  mergeSightings,
  normalizeQueueText,
  sightingAsMet,
  statusOnResight,
  toAnkiTsv,
} from "./vocab-queue-core.ts";
import type { VocabSighting } from "./types.ts";

test("normalizeQueueText: NFKC, whitespace, case", () => {
  assert.equal(normalizeQueueText(" 間に合う "), "間に合う");
  assert.equal(normalizeQueueText("ｼﾏｯﾀ"), "シマッタ");
  assert.equal(normalizeQueueText("一人 で"), "一人で");
  assert.equal(normalizeQueueText("Tsuzuki"), "tsuzuki");
});

const s = (over: Partial<VocabSighting>): VocabSighting => ({
  at: "2026-11-09T00:00:00.000Z",
  context: null,
  sessionId: null,
  questionId: null,
  label: null,
  ...over,
});

test("mergeSightings: dedupes by question, else by moment+context, caps length", () => {
  const a = s({ questionId: "q1", context: "仕事のつづき" });
  assert.equal(mergeSightings([a], s({ questionId: "q1" })).length, 1);
  assert.equal(mergeSightings([a], s({ questionId: "q2" })).length, 2);
  const b = s({ context: "read in Satori" });
  assert.equal(mergeSightings([b], s({ context: "read in Satori" })).length, 1);
  assert.equal(mergeSightings([b], s({ context: "different" })).length, 2);
  const many = Array.from({ length: 20 }, (_, i) => s({ questionId: `q${i}` }));
  const merged = mergeSightings(many, s({ questionId: "new" }));
  assert.equal(merged.length, 20);
  assert.equal(merged[19].questionId, "new");
  assert.equal(merged[0].questionId, "q1");
});

test("statusOnResight: carded stays, everything else requeues", () => {
  assert.equal(statusOnResight("carded"), "carded");
  assert.equal(statusOnResight("known"), "queued");
  assert.equal(statusOnResight("skipped"), "queued");
  assert.equal(statusOnResight("queued"), "queued");
});

test("toAnkiTsv: header lines, one row per word, flattened cells", () => {
  const tsv = toAnkiTsv([
    {
      text: "続き",
      reading: "つづき",
      meaning: "continuation,\tthe rest",
      sightings: [s({ context: "仕事の\nつづき" })],
      lastSeenAt: new Date("2026-11-09T10:00:00Z"),
    },
    { text: "ほら", reading: null, meaning: null, sightings: [], lastSeenAt: new Date("2026-11-05T10:00:00Z") },
  ]);
  const lines = tsv.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 4), ["#separator:tab", "#html:true", "#columns:Front\tBack\tTags", "#tags column:3"]);
  assert.equal(lines[4], "続き\t<b>つづき</b><br>continuation, the rest<br><i>仕事の つづき</i>\tjlpt-hub seen-2026-11");
  assert.equal(lines[5], "ほら\t\tjlpt-hub seen-2026-11");
});

test("mergeSightings: a repeat on the same question fills a missing as_met without bumping", () => {
  const a = s({ questionId: "q1", context: "おおぜいの人" });
  const merged = mergeSightings([a], s({ questionId: "q1", asMet: "おおぜい" }));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].asMet, "おおぜい");
  assert.equal(merged[0].context, "おおぜいの人");
  // An as_met already recorded is kept; no as_met on the repeat changes nothing.
  assert.equal(mergeSightings(merged, s({ questionId: "q1", asMet: "オオゼイ" }))[0].asMet, "おおぜい");
  const unchanged = [a];
  assert.equal(mergeSightings(unchanged, s({ questionId: "q1" })), unchanged);
});

test("sightingAsMet: trimmed printed form, null when absent or the same word as text", () => {
  assert.equal(sightingAsMet(" おおぜい ", "大勢"), "おおぜい");
  assert.equal(sightingAsMet("ｵｵｾﾞｲ", "大勢"), "オオゼイ");
  assert.equal(sightingAsMet("大勢", "大勢"), null);
  assert.equal(sightingAsMet(" ", "大勢"), null);
  assert.equal(sightingAsMet(null, "大勢"), null);
  assert.equal(sightingAsMet(undefined, "大勢"), null);
});

test("effectiveAsMet: most recent sighting that has one", () => {
  assert.equal(effectiveAsMet([]), null);
  assert.equal(effectiveAsMet([s({}), s({ context: "x" })]), null);
  assert.equal(effectiveAsMet([s({ asMet: "おおぜい" }), s({ asMet: null })]), "おおぜい");
  assert.equal(effectiveAsMet([s({ asMet: "おおぜい" }), s({ asMet: "オオゼイ" }), s({})]), "オオゼイ");
  assert.equal(effectiveAsMet([s({ asMet: "おおぜい" }), s({ asMet: "  " })]), "おおぜい");
});

test("toAnkiTsv: as_met goes on the front, the kanji form leads the back; columns unchanged", () => {
  const tsv = toAnkiTsv([
    {
      text: "大勢",
      reading: "おおぜい",
      meaning: "a crowd, many people",
      sightings: [s({ context: "おおぜいの人が来た", asMet: "おおぜい" })],
      lastSeenAt: new Date("2026-11-12T10:00:00Z"),
    },
    { text: "続き", reading: "つづき", meaning: null, sightings: [s({ context: "仕事のつづき" })], lastSeenAt: new Date("2026-11-09T10:00:00Z") },
    { text: "ほら", reading: null, meaning: null, sightings: [s({ asMet: "ホラ" })], lastSeenAt: new Date("2026-11-05T10:00:00Z") },
  ]);
  const lines = tsv.trimEnd().split("\n");
  assert.equal(lines[2], "#columns:Front\tBack\tTags");
  assert.equal(lines[4], "おおぜい\t大勢<br><b>おおぜい</b><br>a crowd, many people<br><i>おおぜいの人が来た</i>\tjlpt-hub seen-2026-11");
  // Without as_met the row is exactly what it was before.
  assert.equal(lines[5], "続き\t<b>つづき</b><br><i>仕事のつづき</i>\tjlpt-hub seen-2026-11");
  assert.equal(lines[6], "ホラ\tほら\tjlpt-hub seen-2026-11");
  for (const l of lines.slice(4)) assert.equal(l.split("\t").length, 3);
});

// ---- Queue linking (insert and relink share the ladder) -----------------------------------

const library: Record<string, { id: string; headword: string }> = {
  大勢: { id: "oozei", headword: "大勢" },
  おおぜい: { id: "oozei", headword: "大勢" },
  きれい: { id: "kirei", headword: "きれい" },
  はく: { id: "haku-wear", headword: "履く" },
};
const lookup = (t: string) => library[t] ?? null;

test("matchQueueItem: text first", () => {
  assert.deepEqual(matchQueueItem("大勢", "おおぜい", lookup), { itemId: "oozei", via: "text" });
  assert.deepEqual(matchQueueItem("おおぜい", null, lookup), { itemId: "oozei", via: "text" });
});

test("matchQueueItem: reading only when the library writes the word in kana", () => {
  assert.deepEqual(matchQueueItem("綺麗", "きれい", lookup), { itemId: "kirei", via: "reading" });
  // 掃く (はく) must not land on 履く (はく): a homophone, left unlinked.
  assert.equal(matchQueueItem("掃く", "はく", lookup), null);
  assert.equal(matchQueueItem("鳴き声", null, lookup), null);
  assert.equal(matchQueueItem("鳴き声", "  ", lookup), null);
  assert.equal(matchQueueItem("  ", null, lookup), null);
});

test("decideQueueLink: fills a null link, never changes an existing one", () => {
  assert.deepEqual(decideQueueLink({ itemId: null, text: "大勢", reading: null }, lookup), { itemId: "oozei", via: "text" });
  assert.equal(decideQueueLink({ itemId: "something-else", text: "大勢", reading: null }, lookup), null);
  assert.equal(decideQueueLink({ itemId: null, text: "入社試験", reading: "にゅうしゃしけん" }, lookup), null);
});

test("exportFilename carries status and date", () => {
  assert.equal(exportFilename("queued", new Date("2026-11-09T23:00:00Z")), "jlpt-hub-queue-queued-2026-11-09.tsv");
});
