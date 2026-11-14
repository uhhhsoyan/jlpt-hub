import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceRows,
  describeAttempt,
  evidenceKind,
  groupUnresolved,
  linkedItemIds,
  mergeMeta,
  pickAttempt,
  planAttemptPatch,
  unresolvedOccurrences,
  type AttemptRef,
  type AttemptState,
} from "./ledger-core.ts";
import type { QuestionTag } from "./types.ts";

// ---- evidenceKind / buildEvidenceRows ---------------------------------------------------

test("evidenceKind: practice needs a grade, lesson is always exposure", () => {
  assert.equal(evidenceKind("practice", true), "answer");
  assert.equal(evidenceKind("practice", false), "answer");
  assert.equal(evidenceKind("practice", null), null);
  assert.equal(evidenceKind("lesson", true), "exposure");
  assert.equal(evidenceKind("lesson", null), "exposure");
});

const at = new Date("2026-11-10T00:00:00.000Z");
const ctx = { sessionId: "s1", surface: "claude-ai" as const, occurredAt: at };

test("buildEvidenceRows: practice skips ungraded links and keeps correct", () => {
  const rows = buildEvidenceRows(
    [
      { questionId: "q1", itemId: "a", isCorrect: false },
      { questionId: "q2", itemId: "b", isCorrect: null },
      { questionId: "q3", itemId: "c", isCorrect: true },
    ],
    { ...ctx, mode: "practice" },
  );
  assert.deepEqual(
    rows.map((r) => [r.itemId, r.kind, r.correct]),
    [
      ["a", "answer", false],
      ["c", "answer", true],
    ],
  );
  assert.deepEqual(rows[0].meta, { sessionId: "s1", questionId: "q1", surface: "claude-ai", mode: "practice", rebuilt: true });
  assert.equal(rows[0].source, "practice");
  assert.equal(rows[0].occurredAt, at);
});

test("buildEvidenceRows: lesson writes an exposure even for ungraded links", () => {
  const rows = buildEvidenceRows([{ questionId: "q2", itemId: "b", isCorrect: null }], { ...ctx, mode: "lesson" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "exposure");
  assert.equal(rows[0].correct, null);
});

test("buildEvidenceRows: no links, no rows", () => {
  assert.deepEqual(buildEvidenceRows([], { ...ctx, mode: "practice" }), []);
});

test("linkedItemIds: distinct resolved ids in order, unresolved dropped", () => {
  const tags: QuestionTag[] = [
    { kind: "grammar", text: "〜ほど〜ない", itemId: "hodo" },
    { kind: "grammar", text: "〜といい", itemId: null },
    { kind: "grammar", text: "ほど", itemId: "hodo" },
    { kind: "vocab", text: "靴", itemId: "kutsu" },
  ];
  assert.deepEqual(linkedItemIds(tags), ["hodo", "kutsu"]);
  assert.deepEqual(linkedItemIds([]), []);
});

// ---- groupUnresolved --------------------------------------------------------------------

test("groupUnresolved: one entry per kind+text with every number", () => {
  const groups = groupUnresolved([
    { number: 11, kind: "grammar", text: "〜といい" },
    { number: 12, kind: "grammar", text: "〜といい" },
    { number: 12, kind: "vocab", text: "続き" },
    { number: 13, kind: "grammar", text: " 〜といい " },
  ]);
  assert.deepEqual(groups, [
    { kind: "grammar", text: "〜といい", numbers: [11, 12, 13] },
    { kind: "vocab", text: "続き", numbers: [12] },
  ]);
});

test("groupUnresolved: same text under different kinds stays separate", () => {
  const groups = groupUnresolved([
    { number: 1, kind: "grammar", text: "ほど" },
    { number: 2, kind: "vocab", text: "ほど" },
  ]);
  assert.equal(groups.length, 2);
});

test("groupUnresolved: a repeated printed number is listed once", () => {
  // Multi-blank questions logged as the same number twice.
  const groups = groupUnresolved([
    { number: 4, kind: "grammar", text: "〜ないで" },
    { number: 4, kind: "grammar", text: "〜ないで" },
  ]);
  assert.deepEqual(groups, [{ kind: "grammar", text: "〜ないで", numbers: [4] }]);
});

test("groupUnresolved: empty input", () => {
  assert.deepEqual(groupUnresolved([]), []);
});

test("unresolvedOccurrences: only tags without an itemId", () => {
  const occ = unresolvedOccurrences([
    { number: 1, tags: [{ kind: "grammar", text: "A", itemId: "x" }, { kind: "grammar", text: "B", itemId: null }] },
    { number: 2, tags: [] },
    { number: 3, tags: [{ kind: "vocab", text: "C", itemId: null }] },
  ]);
  assert.deepEqual(occ, [
    { number: 1, kind: "grammar", text: "B" },
    { number: 3, kind: "vocab", text: "C" },
  ]);
});

// ---- mergeMeta --------------------------------------------------------------------------

test("mergeMeta: overwrites, adds and keeps unmentioned keys", () => {
  assert.deepEqual(mergeMeta({ part: "examples", blank: 1 }, { blank: 2, wrote: "ないで" }), {
    part: "examples",
    blank: 2,
    wrote: "ないで",
  });
});

test("mergeMeta: null removes a key; removing the last key yields null", () => {
  assert.deepEqual(mergeMeta({ a: 1, b: 2 }, { a: null }), { b: 2 });
  assert.equal(mergeMeta({ a: 1 }, { a: null }), null);
});

test("mergeMeta: removing an absent key is a no-op, empty patch keeps current", () => {
  assert.deepEqual(mergeMeta({ a: 1 }, { zzz: null }), { a: 1 });
  assert.deepEqual(mergeMeta({ a: 1 }, {}), { a: 1 });
  assert.equal(mergeMeta(null, {}), null);
  assert.equal(mergeMeta(undefined, { a: null }), null);
});

test("mergeMeta: shallow, nested objects are replaced not merged; current is not mutated", () => {
  const current = { choice: { picked: 1, answer: 2 } };
  const out = mergeMeta(current, { choice: { picked: 3 } });
  assert.deepEqual(out, { choice: { picked: 3 } });
  assert.deepEqual(current, { choice: { picked: 1, answer: 2 } });
});

test("mergeMeta: falsy non-null values are kept", () => {
  assert.deepEqual(mergeMeta(null, { zero: 0, empty: "", no: false }), { zero: 0, empty: "", no: false });
});

// ---- pickAttempt ------------------------------------------------------------------------

const a = (number: number, note: string | null = null, stem: string | null = "", tags: string[] = []): AttemptRef => ({
  number,
  note,
  stem,
  tags: tags.map((text) => ({ text })),
});

test("pickAttempt: unique number returns its row and 1-based position", () => {
  const rows = [a(1), a(2, "picked つもり"), a(3)];
  const picked = pickAttempt(rows, 2);
  assert.equal(picked.row, rows[1]);
  assert.equal(picked.position, 2);
});

test("pickAttempt: duplicate number without position lists the candidates", () => {
  const rows = [a(1), a(4, "blank 1: wrote ないで"), a(4, null, "雨が降らない＿＿、出かけます"), a(5)];
  assert.throws(
    () => pickAttempt(rows, 4),
    (e: Error) =>
      e.message.includes("2 attempts in this session are numbered 4") &&
      e.message.includes('position 2 (#4, "blank 1: wrote ないで")') &&
      e.message.includes("position 3 (#4, \"雨が降らない＿＿、出かけます\")") &&
      e.message.includes("Pass position"),
  );
});

test("pickAttempt: position disambiguates a duplicate number", () => {
  const rows = [a(1), a(4, "first"), a(4, "second")];
  assert.equal(pickAttempt(rows, 4, 3).row.note, "second");
  assert.equal(pickAttempt(rows, 4, 2).row.note, "first");
});

test("pickAttempt: position on a unique number must agree with it", () => {
  const rows = [a(1), a(2), a(3)];
  assert.equal(pickAttempt(rows, 2, 2).position, 2);
  assert.throws(() => pickAttempt(rows, 2, 3), /Position 3 is attempt #3, not #2\. Attempts numbered 2: position 2/);
});

test("pickAttempt: position pointing at a number that does not exist anywhere", () => {
  assert.throws(() => pickAttempt([a(1), a(2)], 9, 1), /Position 1 is attempt #1, not #9\. No attempt is numbered 9\./);
});

test("pickAttempt: out-of-range position", () => {
  const rows = [a(1), a(2)];
  assert.throws(() => pickAttempt(rows, 1, 3), /out of range: the session has 2 attempts \(positions 1-2\)/);
  assert.throws(() => pickAttempt(rows, 1, 0), /out of range/);
});

test("pickAttempt: unknown number lists the numbers present, sorted and distinct", () => {
  const rows = [a(3), a(1), a(3), a(2)];
  assert.throws(() => pickAttempt(rows, 7), /No attempt numbered 7 in this session\. Numbers present: 1, 2, 3\./);
});

test("pickAttempt: empty session", () => {
  assert.throws(() => pickAttempt([], 1), /no attempts/);
});

test("describeAttempt: note, then stem, then tags, truncated", () => {
  assert.equal(describeAttempt(a(2, "  "), 1), 'position 1 (#2, "no note or stem")');
  assert.equal(describeAttempt(a(2, null, "", ["〜ほど〜ない", "より"]), 1), 'position 1 (#2, "〜ほど〜ない, より")');
  assert.equal(describeAttempt(a(2, null, "stem text"), 4), 'position 4 (#2, "stem text")');
  const long = "x".repeat(80);
  const d = describeAttempt(a(1, long), 1);
  assert.ok(d.endsWith('…")'));
  assert.ok(d.length < 80);
});

// ---- planAttemptPatch -------------------------------------------------------------------

const state = (over: Partial<AttemptState> = {}): AttemptState => ({
  isCorrect: false,
  rootCause: "vocab-confusion",
  note: "picked ないで",
  stem: "",
  explanation: null,
  meta: { part: "examples" },
  tags: [{ kind: "grammar", text: "〜ないで", itemId: "naide" }],
  ...over,
});

test("planAttemptPatch: empty patch changes nothing", () => {
  const plan = planAttemptPatch(state(), {});
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.evidenceStale, false);
  assert.deepEqual(plan.next, state());
});

test("planAttemptPatch: re-tagging marks evidence stale", () => {
  const tags: QuestionTag[] = [{ kind: "grammar", text: "〜ないと", itemId: "naito" }];
  const plan = planAttemptPatch(state(), { tags });
  assert.deepEqual(plan.changed, ["tags"]);
  assert.equal(plan.evidenceStale, true);
  assert.deepEqual(plan.next.tags, tags);
});

test("planAttemptPatch: identical tags (same itemId) are not a change", () => {
  const plan = planAttemptPatch(state(), { tags: [{ kind: "grammar", text: "〜ないで", itemId: "naide" }] });
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.evidenceStale, false);
});

test("planAttemptPatch: same text now resolving to an item is a change", () => {
  const plan = planAttemptPatch(state({ tags: [{ kind: "grammar", text: "〜といい", itemId: null }] }), {
    tags: [{ kind: "grammar", text: "〜といい", itemId: "toii" }],
  });
  assert.deepEqual(plan.changed, ["tags"]);
});

test("planAttemptPatch: clearing tags is allowed and stale", () => {
  const plan = planAttemptPatch(state(), { tags: [] });
  assert.deepEqual(plan.next.tags, []);
  assert.equal(plan.evidenceStale, true);
});

test("planAttemptPatch: correct change is stale; root cause is kept unless cleared", () => {
  const flipped = planAttemptPatch(state(), { correct: true });
  assert.deepEqual(flipped.changed, ["correct"]);
  assert.equal(flipped.evidenceStale, true);
  assert.equal(flipped.next.rootCause, "vocab-confusion");

  const cleared = planAttemptPatch(state(), { correct: true, rootCause: null });
  assert.deepEqual(cleared.changed, ["correct", "root_cause"]);
  assert.equal(cleared.next.rootCause, null);
});

test("planAttemptPatch: correct to null (ungradable) is a change", () => {
  const plan = planAttemptPatch(state(), { correct: null });
  assert.equal(plan.next.isCorrect, null);
  assert.equal(plan.evidenceStale, true);
});

test("planAttemptPatch: unchanged values are not reported", () => {
  const plan = planAttemptPatch(state(), { correct: false, rootCause: "vocab-confusion", note: "picked ないで" });
  assert.deepEqual(plan.changed, []);
});

test("planAttemptPatch: text fields trim, blank or null clears; stem clears to empty string", () => {
  const plan = planAttemptPatch(state({ stem: "雨が＿＿", explanation: "rule" }), { note: "   ", stem: null, explanation: "" });
  assert.deepEqual(plan.changed, ["note", "stem", "explanation"]);
  assert.equal(plan.next.note, null);
  assert.equal(plan.next.stem, "");
  assert.equal(plan.next.explanation, null);
  assert.equal(plan.evidenceStale, false);

  const trimmed = planAttemptPatch(state(), { note: "  picked ないで  " });
  assert.deepEqual(trimmed.changed, []);
});

test("planAttemptPatch: meta merges shallowly and only reports a real change", () => {
  const plan = planAttemptPatch(state(), { meta: { blank: 2 } });
  assert.deepEqual(plan.changed, ["meta"]);
  assert.deepEqual(plan.next.meta, { part: "examples", blank: 2 });

  const same = planAttemptPatch(state(), { meta: { part: "examples" } });
  assert.deepEqual(same.changed, []);

  const removed = planAttemptPatch(state(), { meta: { part: null } });
  assert.deepEqual(removed.changed, ["meta"]);
  assert.equal(removed.next.meta, null);

  const noop = planAttemptPatch(state({ meta: null }), { meta: { gone: null } });
  assert.deepEqual(noop.changed, []);
});

test("planAttemptPatch: does not mutate the current state", () => {
  const current = state();
  planAttemptPatch(current, { tags: [], correct: true, meta: { part: null }, note: null });
  assert.deepEqual(current, state());
});
