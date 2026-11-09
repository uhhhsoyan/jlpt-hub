import { test } from "node:test";
import assert from "node:assert/strict";
import { exportFilename, mergeSightings, normalizeQueueText, statusOnResight, toAnkiTsv } from "./vocab-queue-core.ts";
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

test("exportFilename carries status and date", () => {
  assert.equal(exportFilename("queued", new Date("2026-11-09T23:00:00Z")), "jlpt-hub-queue-queued-2026-11-09.tsv");
});
