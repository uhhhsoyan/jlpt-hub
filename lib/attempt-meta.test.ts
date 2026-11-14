import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoReservedMetaKeys,
  attemptLabel,
  attemptMetaPatch,
  attemptName,
  compareAttempts,
  evidenceDate,
  normalizeSlips,
  normalizeSlipText,
  parseDoneOn,
  readDoneOn,
  readPart,
  readSlips,
  tallySlips,
} from "./attempt-meta.ts";

// ---- part ---------------------------------------------------------------------------------

test("readPart: positive integers under questionPart only", () => {
  assert.equal(readPart({ questionPart: 2 }), 2);
  assert.equal(readPart({ questionPart: 0 }), null);
  assert.equal(readPart({ questionPart: 1.5 }), null);
  assert.equal(readPart({ questionPart: "2" }), null);
  // A lesson's meta.part is the lesson section, never the blank.
  assert.equal(readPart({ part: "れんしゅう1" }), null);
  assert.equal(readPart({ part: 2 }), null);
  assert.equal(readPart(null), null);
  assert.equal(readPart(undefined), null);
});

test("attemptLabel / attemptName", () => {
  assert.equal(attemptLabel(7, null), "7");
  assert.equal(attemptLabel(7, 1), "7①");
  assert.equal(attemptLabel(7, 2), "7②");
  assert.equal(attemptLabel(7, 20), "7⑳");
  assert.equal(attemptLabel(7, 21), "7(21)");
  assert.equal(attemptName(7, null), "#7");
  assert.equal(attemptName(7, 2), "#7 part 2");
});

test("compareAttempts: number, then part, no part first", () => {
  const rows = [
    { number: 8, meta: null },
    { number: 7, meta: { questionPart: 2 } },
    { number: 7, meta: null },
    { number: 7, meta: { questionPart: 1 } },
  ];
  assert.deepEqual(
    [...rows].sort(compareAttempts).map((r) => attemptLabel(r.number, readPart(r.meta))),
    ["7", "7①", "7②", "8"],
  );
});

// ---- done_on ------------------------------------------------------------------------------

test("parseDoneOn: YYYY-MM-DD only, real dates only, null clears", () => {
  assert.equal(parseDoneOn("2026-11-11"), "2026-11-11");
  assert.equal(parseDoneOn(" 2026-11-11 "), "2026-11-11");
  assert.equal(parseDoneOn(null), null);
  for (const bad of ["2026-11-31", "2026-02-29", "11/11/2026", "2026-11-11T10:00:00Z", "2026-1-1", "", "yesterday"]) {
    assert.throws(() => parseDoneOn(bad), /done_on must be an ISO date \(YYYY-MM-DD\)/, bad);
  }
  assert.equal(parseDoneOn("2028-02-29"), "2028-02-29");
});

test("readDoneOn: none, date, or invalid (hand edits)", () => {
  assert.deepEqual(readDoneOn(null), { kind: "none" });
  assert.deepEqual(readDoneOn({ done_on: null }), { kind: "none" });
  const d = readDoneOn({ done_on: "2026-11-11" });
  assert.equal(d.kind, "date");
  if (d.kind === "date") {
    assert.equal(d.iso, "2026-11-11");
    assert.equal(d.at.toISOString(), "2026-11-11T00:00:00.000Z");
  }
  assert.deepEqual(readDoneOn({ done_on: "Nov 11" }), { kind: "invalid", raw: "Nov 11" });
  assert.deepEqual(readDoneOn({ done_on: 20261111 }), { kind: "invalid", raw: 20261111 });
});

test("evidenceDate: done_on wins over the session date; same instant as a bare taken_at", () => {
  const session = new Date("2026-11-10");
  assert.equal(evidenceDate(null, session), session);
  assert.equal(evidenceDate({ part: "examples" }, session), session);
  assert.equal(evidenceDate({ done_on: "2026-11-11" }, session).getTime(), new Date("2026-11-11").getTime());
  assert.throws(() => evidenceDate({ done_on: "11/11" }, session, "Attempt #12"), /Attempt #12 has meta\.done_on "11\/11"/);
});

// ---- slips --------------------------------------------------------------------------------

test("normalizeSlips: kinds like root causes, text trimmed, repeats dropped", () => {
  assert.deepEqual(
    normalizeSlips([
      { kind: "Vocab Misread", text: "  read 時 as 時間 " },
      { kind: "vocab_misread", text: "read 時 as 時間" },
      { kind: "subject confusion", text: "gave the final verb to the listener" },
    ]),
    [
      { kind: "vocab-misread", text: "read 時 as 時間" },
      { kind: "subject-confusion", text: "gave the final verb to the listener" },
    ],
  );
  assert.deepEqual(normalizeSlips([]), []);
  assert.throws(() => normalizeSlips([{ kind: " - ", text: "x" }]), /slips\[0\]\.kind is empty/);
  assert.throws(() => normalizeSlips([{ kind: "tense", text: "   " }]), /slips\[0\]\.text is empty/);
});

test("readSlips: skips malformed entries", () => {
  assert.deepEqual(readSlips({ slips: [{ kind: "tense", text: "past read as present" }, "junk", { kind: 1, text: "x" }, null] }), [
    { kind: "tense", text: "past read as present" },
  ]);
  assert.deepEqual(readSlips({ slips: "not a list" }), []);
  assert.deepEqual(readSlips(null), []);
});

test("normalizeSlipText: NFKC, case, whitespace, trailing punctuation", () => {
  assert.equal(normalizeSlipText("  Read 時 as  時間. "), "read 時 as 時間");
  assert.equal(normalizeSlipText("ましょうか read as ＂should we＂。"), 'ましょうか read as "should we"');
});

test("tallySlips: by kind and by normalised text, most frequent first", () => {
  const tally = tallySlips([
    { number: 1, meta: { slips: [{ kind: "vocab-misread", text: "read 時 as 時間" }] } },
    { number: 2, meta: null },
    {
      number: 3,
      meta: {
        slips: [
          { kind: "pattern-misread", text: "〜ましょうか read as 'should we'" },
          { kind: "Vocab Misread", text: "Read 時 as 時間." },
        ],
      },
    },
    { number: 3, meta: { slips: [{ kind: "subject-confusion", text: "final verb given to the listener" }] } },
    { meta: { slips: [{ kind: "pattern-misread", text: "〜ましょうか read as 'should we'" }] } },
  ]);
  assert.equal(tally.total, 5);
  assert.deepEqual(tally.byKind, [
    { kind: "vocab-misread", n: 2, numbers: [1, 3] },
    { kind: "pattern-misread", n: 2, numbers: [3] },
    { kind: "subject-confusion", n: 1, numbers: [3] },
  ]);
  assert.deepEqual(tally.byText, [
    { text: "read 時 as 時間", n: 2, kinds: ["vocab-misread"] },
    { text: "〜ましょうか read as 'should we'", n: 2, kinds: ["pattern-misread"] },
    { text: "final verb given to the listener", n: 1, kinds: ["subject-confusion"] },
  ]);
});

test("tallySlips: same text under two kinds groups once with both kinds", () => {
  const tally = tallySlips([
    { meta: { slips: [{ kind: "particle", text: "used に for で" }] } },
    { meta: { slips: [{ kind: "other", text: "Used に for で" }] } },
  ]);
  assert.deepEqual(tally.byText, [{ text: "used に for で", n: 2, kinds: ["particle", "other"] }]);
});

test("tallySlips: nothing to count", () => {
  assert.deepEqual(tallySlips([]), { total: 0, byKind: [], byText: [] });
  assert.deepEqual(tallySlips([{ meta: null }, { meta: { part: "examples" } }]), { total: 0, byKind: [], byText: [] });
});

// ---- writing ------------------------------------------------------------------------------

test("attemptMetaPatch: only given fields; empty slips and null clear", () => {
  assert.deepEqual(attemptMetaPatch({}), {});
  assert.deepEqual(attemptMetaPatch({ part: 2, doneOn: "2026-11-11", slips: [{ kind: "tense", text: "x" }] }), {
    questionPart: 2,
    done_on: "2026-11-11",
    slips: [{ kind: "tense", text: "x" }],
  });
  assert.deepEqual(attemptMetaPatch({ part: null, doneOn: null, slips: [] }), { questionPart: null, done_on: null, slips: null });
});

test("assertNoReservedMetaKeys: done_on, slips and questionPart belong to their fields", () => {
  assert.doesNotThrow(() => assertNoReservedMetaKeys({ part: "examples", blank: 1 }));
  assert.doesNotThrow(() => assertNoReservedMetaKeys(null));
  assert.throws(() => assertNoReservedMetaKeys({ done_on: "2026-11-11" }), /meta\.done_on is set by the done_on field/);
  assert.throws(() => assertNoReservedMetaKeys({ slips: [] }, "attempts[2].meta"), /attempts\[2\]\.meta\.slips is set by the slips field/);
  assert.throws(() => assertNoReservedMetaKeys({ questionPart: 2 }), /pass part instead/);
});
