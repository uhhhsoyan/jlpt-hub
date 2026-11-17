import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLessonReview,
  isReviewWorthy,
  parseLessonNumber,
  selectLessonSessions,
  type LessonQuestionRow,
  type LessonSessionRow,
} from "./lesson-review.ts";

const at = (d: number) => new Date(Date.UTC(2026, 10, d));

// Label and source_name shapes as they appear in the live ledger.
const sessions: LessonSessionRow[] = [
  { id: "l10", label: "SKM N4 L10 れんしゅう2 (open book)", sourceSlug: "skm-n4-bunpou", sourceName: "実力養成編 第1部 10課 れんしゅう2", takenAt: at(10) },
  { id: "l11ex", label: "SKM N4 L11 examples", sourceSlug: "skm-n4-bunpou", sourceName: "実力養成編 第1部 11課 examples", takenAt: at(10) },
  { id: "l11r1", label: "SKM N4 L11 れんしゅう1", sourceSlug: "skm-n4-bunpou", sourceName: "実力養成編 第1部 11課 れんしゅう1", takenAt: at(11) },
  { id: "l12r2", label: "SKM N4 L12 れんしゅう2", sourceSlug: "skm-n4-bunpou", sourceName: "実力養成編 第1部 12課 れんしゅう2", takenAt: at(12) },
  { id: "l12ex", label: "SKM N4 L12 examples", sourceSlug: "skm-n4-bunpou", sourceName: "実力養成編 第1部 12課 examples", takenAt: at(12) },
  { id: "l3", label: "SKM N4 L3 examples (open book)", sourceSlug: "skm-n4-bunpou", sourceName: "新完全マスター 文法 N4 — 実力養成編 第1部 3課", takenAt: at(4) },
  { id: "odd", label: "Chat drill: ほど/より", sourceSlug: null, sourceName: "chat", takenAt: at(13) },
];

const q = (sessionId: string, number: number, isCorrect: boolean | null, extra: Partial<LessonQuestionRow> = {}): LessonQuestionRow => ({
  sessionId,
  number,
  isCorrect,
  rootCause: null,
  note: null,
  tags: [],
  meta: null,
  stem: "",
  choices: [],
  explanation: null,
  ...extra,
});

const tag = (text: string, itemId: string | null) => ({ kind: "grammar" as const, text, itemId });

const questions: LessonQuestionRow[] = [
  q("l10", 1, false, { rootCause: "misparse", tags: [tag("〜ばかり", "bakari")] }),
  q("l11ex", 11, true),
  q("l11ex", 12, true, { note: "hesitated between に and で", meta: { part: "examples" } }),
  q("l11r1", 1, false, { rootCause: "pattern-glue", note: "wrote 行くたら", tags: [tag("〜たら（条件）", "tara")], meta: {} }),
  q("l11r1", 2, null, { tags: [tag("〜ところだ", null)] }),
  q("l11r1", 3, true),
  q("l12r2", 2, false, { rootCause: "context-cue-missed", tags: [tag("〜たら（条件）", "tara"), tag("〜たら（条件）", "tara")], stem: "雨が＿＿、行きません。", choices: ["ふったら", "ふると"], explanation: "Specific occasion → たら." }),
  q("l12r2", 1, false, { rootCause: "context-cue-missed", tags: [tag("〜そうだ", null)] }),
  q("l12ex", 5, false, { tags: [tag("〜そうだ", null)] }),
  q("l12ex", 6, true),
];

test("parseLessonNumber reads L12 / Lesson 12 from the label or N課 from the detail", () => {
  assert.equal(parseLessonNumber("SKM N4 L12 れんしゅう2", null), 12);
  assert.equal(parseLessonNumber("Genki Lesson 7 workbook", null), 7);
  assert.equal(parseLessonNumber("SKM N4 文法", "実力養成編 第1部 12課"), 12);
  // 第1部 is the part, not the lesson.
  assert.equal(parseLessonNumber("whatever", "新完全マスター 文法 N4 — 実力養成編 第1部 3課"), 3);
  // N4 is a level, not a lesson; no number anywhere means null.
  assert.equal(parseLessonNumber("SKM N4 文法 まとめ", null), null);
  assert.equal(parseLessonNumber("Chat drill: ほど/より", "chat"), null);
  assert.equal(parseLessonNumber("500問 W2D3 p.107", null), null);
});

test("selectLessonSessions: inclusive range, open ends, label/detail substring", () => {
  const ids = (sel: Parameters<typeof selectLessonSessions>[1]) => selectLessonSessions(sessions, sel).map((s) => s.id);
  assert.deepEqual(ids({ lessonFrom: 11, lessonTo: 15 }), ["l11ex", "l11r1", "l12r2", "l12ex"]);
  assert.deepEqual(ids({ lessonFrom: 12 }), ["l12r2", "l12ex"]);
  assert.deepEqual(ids({ lessonTo: 3 }), ["l3"]);
  assert.deepEqual(ids({ lessonFrom: 11, lessonTo: 15, match: "れんしゅう" }), ["l11r1", "l12r2"]);
  assert.deepEqual(ids({ match: "EXAMPLES" }), ["l11ex", "l12ex", "l3"]);
  // No range: sessions without a lesson number stay in.
  assert.equal(ids({}).length, sessions.length);
  assert.deepEqual(ids({ lessonFrom: 20 }), []);
});

test("isReviewWorthy: misses, not-attempted and noted right answers; clean right answers are not", () => {
  assert.equal(isReviewWorthy({ isCorrect: false, note: null }), true);
  assert.equal(isReviewWorthy({ isCorrect: null, note: null }), true);
  assert.equal(isReviewWorthy({ isCorrect: true, note: "slow" }), true);
  assert.equal(isReviewWorthy({ isCorrect: true, note: "   " }), false);
  assert.equal(isReviewWorthy({ isCorrect: true, note: null }), false);
});

test("buildLessonReview groups by session in lesson order and keeps the payload lean", () => {
  const selected = selectLessonSessions(sessions, { lessonFrom: 11, lessonTo: 15 });
  const review = buildLessonReview(selected, questions, { headwords: new Map([["tara", "〜たら（条件）"]]) });
  assert.deepEqual(
    review.sessions.map((s) => s.label),
    ["SKM N4 L11 examples", "SKM N4 L11 れんしゅう1", "SKM N4 L12 examples", "SKM N4 L12 れんしゅう2"],
  );
  const [ex, r1, , r2] = review.sessions;
  assert.deepEqual(ex.score, { correct: 2, graded: 2, questions: 2 });
  assert.deepEqual(ex.review, [{ number: 12, correct: true, note: "hesitated between に and で", tags: [], meta: { part: "examples" } }]);
  // Empty meta and null cause/note are dropped; unlinked tags are listed; not-attempted is included.
  assert.deepEqual(r1.review, [
    { number: 1, correct: false, rootCause: "pattern-glue", note: "wrote 行くたら", tags: ["〜たら（条件）"] },
    { number: 2, correct: null, tags: ["〜ところだ"], unlinked: ["〜ところだ"] },
  ]);
  assert.deepEqual(r1.score, { correct: 1, graded: 2, questions: 3 });
  assert.equal(r1.takenAt, "2026-11-11");
  assert.equal(r1.lesson, 11);
  // Sorted by question number, and no stem/choices/explanation unless asked.
  assert.deepEqual(r2.review.map((a) => a.number), [1, 2]);
  assert.ok(r2.review.every((a) => a.stem === undefined && a.choices === undefined && a.explanation === undefined));
  assert.equal(review.truncated, undefined);
});

test("buildLessonReview rolls up misses by root cause and items missed more than once", () => {
  const selected = selectLessonSessions(sessions, { lessonFrom: 11, lessonTo: 15 });
  const { summary } = buildLessonReview(selected, questions, { headwords: new Map([["tara", "〜たら（条件）"]]) });
  assert.deepEqual(
    { ...summary, missesByRootCause: undefined, repeatedMisses: undefined },
    { sessions: 4, questions: 9, graded: 8, correct: 4, missed: 4, slips: 1, notAttempted: 1, missesByRootCause: undefined, repeatedMisses: undefined },
  );
  assert.deepEqual(summary.missesByRootCause, [
    { rootCause: "context-cue-missed", known: true, misses: 2 },
    { rootCause: "pattern-glue", known: true, misses: 1 },
    { rootCause: "unclassified", known: false, misses: 1 },
  ]);
  // The same item tagged twice on one question counts once; an unlinked tag is keyed by its text.
  assert.deepEqual(summary.repeatedMisses, [
    { text: "〜そうだ", kind: "grammar", itemId: null, misses: 2, where: ["SKM N4 L12 examples #5", "SKM N4 L12 れんしゅう2 #1"] },
    { text: "〜たら（条件）", kind: "grammar", itemId: "tara", misses: 2, where: ["SKM N4 L11 れんしゅう1 #1", "SKM N4 L12 れんしゅう2 #2"] },
  ]);
  // The L10 miss on 〜ばかり is outside the range and never counted.
  assert.ok(!summary.repeatedMisses.some((r) => r.itemId === "bakari"));
});

test("buildLessonReview: include_text adds stored stem/choices/explanation; limit keeps the newest sessions", () => {
  const selected = selectLessonSessions(sessions, { lessonFrom: 11, lessonTo: 15 });
  const withText = buildLessonReview(selected, questions, { includeText: true });
  const r2 = withText.sessions.find((s) => s.sessionId === "l12r2");
  assert.deepEqual(r2?.review.find((a) => a.number === 2)?.choices, ["ふったら", "ふると"]);
  assert.equal(r2?.review.find((a) => a.number === 2)?.explanation, "Specific occasion → たら.");
  // A question with nothing stored gains no empty fields.
  assert.equal(r2?.review.find((a) => a.number === 1)?.stem, undefined);

  const limited = buildLessonReview(selected, questions, { limit: 2 });
  // The two newest (both L12), shown in lesson/label order.
  assert.deepEqual(
    limited.sessions.map((s) => s.sessionId),
    ["l12ex", "l12r2"],
  );
  assert.equal(limited.truncated, 2);
  assert.equal(limited.summary.sessions, 2);
});

test("buildLessonReview: an empty selection is an empty review, not an error", () => {
  const review = buildLessonReview([], questions);
  assert.deepEqual(review.sessions, []);
  assert.equal(review.summary.missed, 0);
  assert.deepEqual(review.summary.repeatedMisses, []);
});
