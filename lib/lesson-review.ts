import { compareAttempts, readSlips, tallySlips } from "./attempt-meta.ts";
import { isKnownRootCause, type ItemKind, type QuestionTag } from "./types.ts";

/**
 * Pure selection, grouping and roll-up for the lesson review (get_lesson_review): what was
 * missed or stumbled on in open-book lesson sessions, for review before a closed-book まとめ
 * test. No DB imports so it unit-tests under `node --test`; lib/lesson-review-db.ts loads the
 * rows. Read-only by construction: it shapes rows already in the ledger and writes nothing,
 * so it cannot touch any accuracy figure.
 */

export interface LessonSessionRow {
  id: string;
  label: string;
  sourceSlug: string | null;
  sourceName: string | null;
  takenAt: Date;
}

export interface LessonQuestionRow {
  sessionId: string;
  number: number;
  isCorrect: boolean | null;
  rootCause: string | null;
  note: string | null;
  tags: QuestionTag[];
  meta: Record<string, unknown> | null;
  stem: string;
  choices: string[];
  explanation: string | null;
}

/**
 * The lesson number a session belongs to, from the label ("SKM N4 L12 れんしゅう2",
 * "Lesson 12") or the source detail ("実力養成編 第1部 12課"). 課 is tried before 第 so
 * "第1部 12課" reads as 12, not 1. Null when neither says.
 */
export function parseLessonNumber(label: string, sourceName: string | null): number | null {
  const ka = /(\d+)\s*課/u;
  const l = /(?:^|[^A-Za-z0-9])L(?:esson)?\s*(\d+)(?![0-9])/i;
  for (const text of [label, sourceName ?? ""]) {
    const m = l.exec(text) ?? ka.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

export interface LessonSelection {
  /** Inclusive lesson range; either end may be open. Sessions with no lesson number are excluded when a range is given. */
  lessonFrom?: number | null;
  lessonTo?: number | null;
  /** Case-insensitive substring of the label or source detail, e.g. "れんしゅう" or "L12". */
  match?: string | null;
}

export type SelectedSession<T extends LessonSessionRow> = T & { lesson: number | null };

export function selectLessonSessions<T extends LessonSessionRow>(sessions: T[], sel: LessonSelection = {}): SelectedSession<T>[] {
  const from = sel.lessonFrom ?? null;
  const to = sel.lessonTo ?? null;
  const match = sel.match?.trim().toLowerCase() || null;
  const out: SelectedSession<T>[] = [];
  for (const s of sessions) {
    const lesson = parseLessonNumber(s.label, s.sourceName);
    if (from !== null || to !== null) {
      if (lesson === null) continue;
      if (from !== null && lesson < from) continue;
      if (to !== null && lesson > to) continue;
    }
    if (match && !`${s.label}\n${s.sourceName ?? ""}`.toLowerCase().includes(match)) continue;
    out.push({ ...s, lesson });
  }
  return out;
}

/** Lean on purpose (a five-lesson review runs to a hundred attempts): empty fields are omitted. */
export interface ReviewAttempt {
  number: number;
  /** false = missed, null = not attempted, true = right but carries a note or slips (worth a look). */
  correct: boolean | null;
  rootCause?: string;
  note?: string;
  /** Every tag's text as logged. */
  tags: string[];
  /** The tags that resolved to no library item (they write no evidence until relink_tags); absent when all linked. */
  unlinked?: string[];
  meta?: Record<string, unknown>;
  stem?: string;
  choices?: string[];
  explanation?: string;
}

export interface ReviewSession {
  sessionId: string;
  label: string;
  source: string | null;
  sourceName: string | null;
  lesson: number | null;
  /** YYYY-MM-DD */
  takenAt: string;
  score: { correct: number; graded: number; questions: number };
  /** Only the attempts worth reviewing; empty for a clean session. */
  review: ReviewAttempt[];
}

export interface RepeatedMiss {
  /** Library headword when linked, else the tag text as logged. */
  text: string;
  kind: ItemKind;
  itemId: string | null;
  misses: number;
  /** "<session label> #<number>" for each miss. */
  where: string[];
}

export interface LessonReviewSummary {
  sessions: number;
  questions: number;
  graded: number;
  correct: number;
  missed: number;
  /** Right answers that carry a note (any note, slips or not). */
  correctWithNote: number;
  notAttempted: number;
  /** Entries in the attempts' structured `slips` field, on right and wrong answers alike. */
  slips: number;
  /** Those slips by kind, most frequent first. */
  slipsByKind: { kind: string; n: number }[];
  /** Missed attempts by root cause; "unclassified" when none was recorded. */
  missesByRootCause: { rootCause: string; known: boolean; misses: number }[];
  /** Items (or unlinked tag texts) missed more than once across the selection. */
  repeatedMisses: RepeatedMiss[];
}

export interface LessonReview {
  sessions: ReviewSession[];
  summary: LessonReviewSummary;
  /** Older matching sessions left out by the limit, when any. */
  truncated?: number;
}

export interface BuildLessonReviewOptions {
  /** Max sessions; the most recent are kept. */
  limit?: number;
  /** Add stem, choices and explanation to each attempt (when stored). */
  includeText?: boolean;
  /** itemId -> headword, for naming linked items in the roll-up. */
  headwords?: Map<string, string>;
}

/** Worth reviewing: wrong, not attempted, or right with a note or slips. */
export function isReviewWorthy(q: Pick<LessonQuestionRow, "isCorrect" | "note"> & { meta?: LessonQuestionRow["meta"] }): boolean {
  return q.isCorrect !== true || !!q.note?.trim() || readSlips(q.meta).length > 0;
}

function toAttempt(q: LessonQuestionRow, includeText: boolean): ReviewAttempt {
  const out: ReviewAttempt = { number: q.number, correct: q.isCorrect, tags: q.tags.map((t) => t.text) };
  if (q.rootCause) out.rootCause = q.rootCause;
  const note = q.note?.trim();
  if (note) out.note = note;
  const unlinked = q.tags.filter((t) => !t.itemId).map((t) => t.text);
  if (unlinked.length > 0) out.unlinked = unlinked;
  if (q.meta && Object.keys(q.meta).length > 0) out.meta = q.meta;
  if (includeText) {
    if (q.stem.trim()) out.stem = q.stem;
    if (q.choices.length > 0) out.choices = q.choices;
    if (q.explanation?.trim()) out.explanation = q.explanation;
  }
  return out;
}

/**
 * Group the review-worthy attempts by session (lesson order, then date, then label) and
 * roll up the misses: by root cause, and the items missed more than once.
 */
export function buildLessonReview(
  sessions: SelectedSession<LessonSessionRow>[],
  questions: LessonQuestionRow[],
  opts: BuildLessonReviewOptions = {},
): LessonReview {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const includeText = opts.includeText ?? false;
  const headwords = opts.headwords ?? new Map<string, string>();

  const newestFirst = [...sessions].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  const kept = newestFirst.slice(0, limit);
  const truncated = newestFirst.length - kept.length;
  kept.sort(
    (a, b) =>
      (a.lesson ?? Number.MAX_SAFE_INTEGER) - (b.lesson ?? Number.MAX_SAFE_INTEGER) ||
      a.takenAt.getTime() - b.takenAt.getTime() ||
      a.label.localeCompare(b.label),
  );

  const bySession = new Map<string, LessonQuestionRow[]>();
  for (const q of questions) {
    const list = bySession.get(q.sessionId);
    if (list) list.push(q);
    else bySession.set(q.sessionId, [q]);
  }

  const summary: LessonReviewSummary = {
    sessions: kept.length,
    questions: 0,
    graded: 0,
    correct: 0,
    missed: 0,
    correctWithNote: 0,
    notAttempted: 0,
    slips: 0,
    slipsByKind: [],
    missesByRootCause: [],
    repeatedMisses: [],
  };
  const causes = new Map<string, number>();
  const repeated = new Map<string, RepeatedMiss>();
  const selectedQuestions: LessonQuestionRow[] = [];

  const out: ReviewSession[] = kept.map((s) => {
    // Printed number, then part (blank): 7, 7 part 1, 7 part 2, 8.
    const qs = [...(bySession.get(s.id) ?? [])].sort(compareAttempts);
    selectedQuestions.push(...qs);
    let graded = 0;
    let correct = 0;
    for (const q of qs) {
      if (q.isCorrect !== null) graded += 1;
      if (q.isCorrect === true) {
        correct += 1;
        if (q.note?.trim()) summary.correctWithNote += 1;
      } else if (q.isCorrect === null) summary.notAttempted += 1;
      else {
        summary.missed += 1;
        const cause = q.rootCause ?? "unclassified";
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
        const seen = new Set<string>();
        for (const t of q.tags) {
          const key = t.itemId ?? `${t.kind}:${t.text.trim()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const entry = repeated.get(key) ?? {
            text: (t.itemId && headwords.get(t.itemId)) || t.text.trim(),
            kind: t.kind,
            itemId: t.itemId ?? null,
            misses: 0,
            where: [],
          };
          entry.misses += 1;
          entry.where.push(`${s.label} #${q.number}`);
          repeated.set(key, entry);
        }
      }
    }
    summary.questions += qs.length;
    summary.graded += graded;
    summary.correct += correct;
    return {
      sessionId: s.id,
      label: s.label,
      source: s.sourceSlug,
      sourceName: s.sourceName,
      lesson: s.lesson,
      takenAt: s.takenAt.toISOString().slice(0, 10),
      score: { correct, graded, questions: qs.length },
      review: qs.filter(isReviewWorthy).map((q) => toAttempt(q, includeText)),
    };
  });

  const slipTally = tallySlips(selectedQuestions);
  summary.slips = slipTally.total;
  summary.slipsByKind = slipTally.byKind.map(({ kind, n }) => ({ kind, n }));
  summary.missesByRootCause = [...causes.entries()]
    .map(([rootCause, misses]) => ({ rootCause, known: isKnownRootCause(rootCause), misses }))
    .sort((a, b) => b.misses - a.misses || a.rootCause.localeCompare(b.rootCause));
  summary.repeatedMisses = [...repeated.values()]
    .filter((r) => r.misses > 1)
    .sort((a, b) => b.misses - a.misses || a.text.localeCompare(b.text));

  return { sessions: out, summary, ...(truncated > 0 ? { truncated } : {}) };
}
