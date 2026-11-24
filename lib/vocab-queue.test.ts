import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptVocabResult,
  decideQueueLink,
  effectiveAsMet,
  emptyQueueResult,
  exportFilename,
  matchQueueItem,
  mergeQueueResults,
  mergeSightings,
  normalizeQueueText,
  planQueueEdit,
  planQueueTargets,
  planResight,
  recordQueuedWord,
  setSightingsAsMet,
  sightingAsMet,
  statusOnResight,
  toAnkiTsv,
  validateQueueUpdate,
  type QueuedWord,
  type QueueEditRow,
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

// ---- Per-row edits (update_vocab_queue `edits`) -------------------------------------------

test("validateQueueUpdate: status needs ids, ids need status, edits must change something", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.throws(() => validateQueueUpdate({}), /Nothing to change/);
  assert.throws(() => validateQueueUpdate({ ids: [id] }), /without status/);
  assert.throws(() => validateQueueUpdate({ status: "known" }), /needs ids/);
  assert.throws(() => validateQueueUpdate({ edits: [{ id }] }), /changes nothing/);
  assert.throws(() => validateQueueUpdate({ edits: [{ id, text: "  " }] }), /text is empty/);
  assert.throws(() => validateQueueUpdate({ edits: [{ id, reading: "a" }, { id, meaning: "b" }] }), /appears twice/);
  assert.doesNotThrow(() => validateQueueUpdate({ ids: [id], status: "carded" }));
  assert.doesNotThrow(() => validateQueueUpdate({ edits: [{ id, asMet: null }] }));
  assert.doesNotThrow(() => validateQueueUpdate({ ids: [id], status: "known", edits: [{ id, meaning: "x" }] }));
});

test("setSightingsAsMet: written on the latest sighting, no new sighting; null clears every one", () => {
  const sightings = [s({ context: "first", asMet: "オオゼイ" }), s({ context: "second" })];
  const set = setSightingsAsMet(sightings, " おおぜい ", "大勢");
  assert.equal(set.length, 2);
  assert.equal(set[1].asMet, "おおぜい");
  assert.equal(set[0].asMet, "オオゼイ");
  assert.equal(effectiveAsMet(set), "おおぜい");
  const cleared = setSightingsAsMet(set, null, "大勢");
  assert.equal(effectiveAsMet(cleared), null);
  assert.equal("asMet" in cleared[0], false);
  // The same word as text means nothing to show: a clear.
  assert.equal(effectiveAsMet(setSightingsAsMet(set, "大勢", "大勢")), null);
  assert.throws(() => setSightingsAsMet([], "おおぜい", "大勢"), /no sightings/);
  assert.deepEqual(setSightingsAsMet([], null, "大勢"), []);
});

test("setSightingsAsMet: the Anki export reads the edited form on the front", () => {
  const sightings = setSightingsAsMet([s({ context: "おおぜいの人" })], "おおぜい", "大勢");
  const line = toAnkiTsv([{ text: "大勢", reading: "おおぜい", meaning: null, sightings, lastSeenAt: new Date("2026-11-12T10:00:00Z") }])
    .trimEnd()
    .split("\n")[4];
  assert.equal(line, "おおぜい\t大勢<br><b>おおぜい</b><br><i>おおぜいの人</i>\tjlpt-hub seen-2026-11");
});

const qrow = (over: Partial<QueueEditRow> = {}): QueueEditRow => ({
  id: "row-1",
  text: "おおぜい",
  norm: "おおぜい",
  reading: null,
  meaning: null,
  itemId: null,
  sightings: [s({ context: "おおぜいの人", label: "500問 W3D2" })],
  ...over,
});
const itemFields: Record<string, { reading: string | null; meaning: string | null }> = {
  oozei: { reading: "おおぜい", meaning: "a crowd, many people" },
  kirei: { reading: "きれい", meaning: "pretty, clean" },
};
const info = (id: string) => itemFields[id];

test("planQueueEdit: as_met only touches sightings, never counts", () => {
  const plan = planQueueEdit(qrow({ text: "大勢", norm: "大勢" }), { id: "row-1", asMet: "おおぜい" }, lookup, info);
  assert.deepEqual(plan.changed, ["as_met"]);
  assert.equal(plan.patch.sightings?.length, 1);
  assert.equal(effectiveAsMet(plan.patch.sightings ?? []), "おおぜい");
  assert.equal(plan.patch.text, undefined);
  assert.equal("seenCount" in plan.patch, false);
  // Same value again: no change at all.
  const again = planQueueEdit(qrow({ text: "大勢", norm: "大勢", sightings: plan.patch.sightings }), { id: "row-1", asMet: "おおぜい" }, lookup, info);
  assert.deepEqual(again, { patch: {}, changed: [] });
});

test("planQueueEdit: text re-links, fills reading/meaning from the item, keeps the printed form as as_met", () => {
  const plan = planQueueEdit(qrow(), { id: "row-1", text: " 大勢 ", asMet: "おおぜい" }, lookup, info);
  assert.deepEqual(plan.changed, ["text", "reading", "meaning", "item", "as_met"]);
  assert.equal(plan.patch.text, "大勢");
  assert.equal(plan.patch.norm, "大勢");
  assert.equal(plan.patch.itemId, "oozei");
  assert.equal(plan.patch.reading, "おおぜい");
  assert.equal(plan.patch.meaning, "a crowd, many people");
  assert.equal(effectiveAsMet(plan.patch.sightings ?? []), "おおぜい");
});

test("planQueueEdit: a new text with no match drops the old link; explicit null is not refilled", () => {
  const linked = qrow({ text: "大勢", norm: "大勢", itemId: "oozei", reading: "おおぜい", meaning: "crowd" });
  const plan = planQueueEdit(linked, { id: "row-1", text: "入社試験" }, lookup, info);
  assert.equal(plan.patch.itemId, null);
  assert.ok(plan.changed.includes("item"));
  // Reading/meaning the row already had are kept.
  assert.equal(plan.patch.reading, undefined);
  const cleared = planQueueEdit(qrow({ text: "綺麗", norm: "綺麗" }), { id: "row-1", text: "きれい", reading: null }, lookup, info);
  assert.equal(cleared.patch.itemId, "kirei");
  assert.equal(cleared.patch.reading, undefined); // was null and explicitly kept null
  assert.equal(cleared.patch.meaning, "pretty, clean");
});

test("planQueueEdit: an as_met equal to the new text is dropped; reading/meaning set and cleared", () => {
  const row = qrow({ text: "大勢", norm: "大勢", sightings: [s({ asMet: "おおぜい" })], reading: "たいせい", meaning: "general situation" });
  const plan = planQueueEdit(row, { id: "row-1", text: "おおぜい" }, lookup, info);
  assert.equal(effectiveAsMet(plan.patch.sightings ?? []), null);
  assert.ok(plan.changed.includes("as_met"));
  const fields = planQueueEdit(row, { id: "row-1", reading: " おおぜい ", meaning: null }, lookup, info);
  assert.deepEqual(fields, { patch: { reading: "おおぜい", meaning: null }, changed: ["reading", "meaning"] });
  // A reading change alone does not re-link.
  assert.equal(fields.patch.itemId, undefined);
});

// ---- log_attempts / update_attempt vocab detail -------------------------------------------

const word = (over: Partial<QueuedWord>) => ({ id: "w", text: "続き", status: "queued" as const, seenCount: 1, itemId: null, asMet: null, ...over });

test("planResight: a new question bumps the count and requeues; the same question changes nothing", () => {
  const existing = { sightings: [s({ questionId: "q1" })], seenCount: 1, status: "known" as const };
  const bumped = planResight(existing, s({ questionId: "q2" }));
  assert.equal(bumped.bumped, true);
  assert.equal(bumped.seenCount, 2);
  assert.equal(bumped.status, "queued");
  assert.equal(bumped.sightings.length, 2);
  const same = planResight(existing, s({ questionId: "q1" }));
  assert.deepEqual(same, { sightings: existing.sightings, bumped: false, seenCount: 1, status: "known" });
  // A carded word that stalls again stays carded.
  assert.equal(planResight({ ...existing, status: "carded" }, s({ questionId: "q3" })).status, "carded");
});

test("attemptVocabResult: a new word and a bumped word are told apart, and vocabQueued still counts both", () => {
  const vq = emptyQueueResult();
  recordQueuedWord(vq, word({ id: "a", text: "続き", itemId: "item-tsuzuki" }), "created");
  recordQueuedWord(vq, word({ id: "b", text: "大勢", seenCount: 2, itemId: "item-oozei" }), "bumped");
  const out = attemptVocabResult(vq);
  assert.equal(out.vocabQueued, 2);
  assert.equal(out.vocab.queued, 1);
  assert.equal(out.vocab.bumped, 1);
  assert.deepEqual(
    out.vocab.words.map((w) => [w.text, w.created, w.seenCount, w.itemId]),
    [
      ["続き", true, 1, "item-tsuzuki"],
      ["大勢", false, 2, "item-oozei"],
    ],
  );
});

test("attemptVocabResult: a word re-seen on the same question is listed but counted neither queued nor bumped", () => {
  const vq = emptyQueueResult();
  recordQueuedWord(vq, word({ text: "続き", seenCount: 3 }), "unchanged");
  const out = attemptVocabResult(vq);
  assert.equal(out.vocabQueued, 0);
  assert.deepEqual([out.vocab.queued, out.vocab.bumped], [0, 0]);
  assert.equal(out.vocab.words[0].created, false);
});

test("attemptVocabResult: no vocab_gaps gives zeros and an empty word list, never undefined", () => {
  assert.deepEqual(attemptVocabResult(null), { vocabQueued: 0, vocab: { queued: 0, bumped: 0, words: [] } });
});

test("mergeQueueResults: sums the counts and keeps the words in call order", () => {
  const a = emptyQueueResult();
  recordQueuedWord(a, word({ text: "猫" }), "created");
  const b = emptyQueueResult();
  recordQueuedWord(b, word({ text: "犬", seenCount: 4 }), "bumped");
  recordQueuedWord(b, word({ text: "鳥" }), "created");
  const m = mergeQueueResults([a, b]);
  assert.deepEqual([m.queued, m.bumped], [2, 1]);
  assert.deepEqual(m.words.map((w) => w.text), ["猫", "犬", "鳥"]);
});

// ---- queue_vocab per-word number --------------------------------------------------------

const SID = "6f1c2b9e-0000-4000-8000-000000000000";

/** queue_vocab's word shape (route.ts queueWordSchema), trimmed to what the plan reads. */
interface Word {
  text: string;
  as_met?: string;
  number?: number;
  part?: number;
}

test("planQueueTargets: no session, number, part or position anywhere is a free queue call", () => {
  const plan = planQueueTargets<Word>([{ text: "続き" }, { text: "大勢", as_met: "おおぜい" }], {});
  assert.deepEqual(plan, { kind: "free", words: [{ text: "続き" }, { text: "大勢", as_met: "おおぜい" }] });
});

test("planQueueTargets: the call-level number covers every word, as before", () => {
  const plan = planQueueTargets<Word>([{ text: "続き" }, { text: "大勢" }], { sessionId: SID, number: 7, part: 2 });
  assert.deepEqual(plan, { kind: "attempts", sessionId: SID, groups: [{ number: 7, part: 2, words: [{ text: "続き" }, { text: "大勢" }] }] });
});

test("planQueueTargets: a per-word number overrides the call-level one and drops its part and position", () => {
  const plan = planQueueTargets(
    [{ text: "猫" }, { text: "犬", number: 31 }, { text: "鳥", number: 33, part: 1 }, { text: "魚", number: 31 }, { text: "馬" }],
    { sessionId: SID, number: 32, part: 2, position: 5 },
  );
  assert.deepEqual(plan, {
    kind: "attempts",
    sessionId: SID,
    groups: [
      { number: 32, part: 2, position: 5, words: [{ text: "猫" }, { text: "馬" }] },
      { number: 31, words: [{ text: "犬" }, { text: "魚" }] },
      { number: 33, part: 1, words: [{ text: "鳥" }] },
    ],
  });
});

test("planQueueTargets: per-word numbers alone (no call-level number) group by question", () => {
  const plan = planQueueTargets<Word>([{ text: "猫", number: 22 }, { text: "犬", number: 25 }], { sessionId: SID });
  assert.equal(plan.kind, "attempts");
  assert.deepEqual(plan.kind === "attempts" ? plan.groups.map((g) => [g.number, g.words.map((w) => w.text)]) : [], [
    [22, ["猫"]],
    [25, ["犬"]],
  ]);
});

test("planQueueTargets: a word without any number, a number without a session, and bad numbers are refused", () => {
  assert.throws(() => planQueueTargets<Word>([{ text: "猫", number: 3 }, { text: "犬" }], { sessionId: SID }), /words\[1\] has no question number/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫", number: 3 }], {}), /pass session_id/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫" }], { number: 3 }), /pass session_id/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫" }], { sessionId: SID }), /words\[0\] has no question number/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫", number: 0 }], { sessionId: SID }), /words\[0\]\.number must be a positive integer/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫", number: 2.5 }], { sessionId: SID }), /words\[0\]\.number must be a positive integer/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫", number: 2, part: -1 }], { sessionId: SID }), /words\[0\]\.part must be a positive integer/);
  assert.throws(() => planQueueTargets<Word>([{ text: "猫" }], { sessionId: SID, number: -4 }), /number must be a positive integer/);
});
