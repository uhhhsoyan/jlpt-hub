import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { items, practiceQuestions, practiceSessions, studySources } from "@/lib/db/schema";
import { buildLessonReview, selectLessonSessions, type LessonReview, type LessonSelection } from "@/lib/lesson-review";
import { loadStudySources, resolveSource } from "@/lib/study-sources-db";

export interface GetLessonReviewInput extends LessonSelection {
  /** Catalog source: slug, name or alias. Omitted = lesson sessions from every source. */
  source?: string | null;
  since?: Date | null;
  /** Exclusive upper bound. */
  until?: Date | null;
  limit?: number;
  includeText?: boolean;
}

export interface LessonReviewResult extends LessonReview {
  selection: { source: string | null; lessonFrom: number | null; lessonTo: number | null; match: string | null };
  hint?: string;
}

/**
 * The lesson review behind the MCP get_lesson_review tool: SELECTs only, over confirmed
 * lesson-mode (open-book) sessions. Practice sessions are never read here, and nothing is
 * written, so the accuracy reports (lib/weakness.ts) are untouched by construction.
 */
export async function getLessonReview(input: GetLessonReviewInput = {}): Promise<LessonReviewResult> {
  const db = getDb();
  let sourceId: string | null = null;
  let sourceSlug: string | null = null;
  const sourceText = input.source?.trim();
  if (sourceText) {
    const sources = await loadStudySources();
    const match = resolveSource(sources, sourceText);
    if (!match) {
      throw new Error(
        `No study source matches "${sourceText}". Use a slug from list_sources (${sources
          .filter((s) => s.active)
          .map((s) => s.slug)
          .join(", ")}).`,
      );
    }
    sourceId = match.id;
    sourceSlug = match.slug;
  }

  const conds = [eq(practiceSessions.status, "confirmed"), eq(practiceSessions.mode, "lesson")];
  if (sourceId) conds.push(eq(practiceSessions.sourceId, sourceId));
  if (input.since) conds.push(gte(practiceSessions.takenAt, input.since));
  if (input.until) conds.push(lt(practiceSessions.takenAt, input.until));
  const sessionRows = await db
    .select({
      id: practiceSessions.id,
      label: practiceSessions.label,
      sourceSlug: studySources.slug,
      sourceName: practiceSessions.sourceName,
      takenAt: practiceSessions.takenAt,
    })
    .from(practiceSessions)
    .leftJoin(studySources, eq(studySources.id, practiceSessions.sourceId))
    .where(and(...conds))
    .orderBy(desc(practiceSessions.takenAt));

  const selected = selectLessonSessions(sessionRows, input);
  const ids = selected.map((s) => s.id);
  const questionRows = ids.length
    ? await db
        .select({
          sessionId: practiceQuestions.sessionId,
          number: practiceQuestions.number,
          isCorrect: practiceQuestions.isCorrect,
          rootCause: practiceQuestions.rootCause,
          note: practiceQuestions.note,
          tags: practiceQuestions.tags,
          meta: practiceQuestions.meta,
          stem: practiceQuestions.stem,
          choices: practiceQuestions.choices,
          explanation: practiceQuestions.explanation,
        })
        .from(practiceQuestions)
        .where(inArray(practiceQuestions.sessionId, ids))
    : [];

  // Headwords for the roll-up, only for items actually missed.
  const missedItemIds = [
    ...new Set(questionRows.filter((q) => q.isCorrect === false).flatMap((q) => q.tags.map((t) => t.itemId).filter((id): id is string => !!id))),
  ];
  const headwordRows = missedItemIds.length
    ? await db.select({ id: items.id, headword: items.headword }).from(items).where(inArray(items.id, missedItemIds))
    : [];

  const review = buildLessonReview(selected, questionRows, {
    limit: input.limit,
    includeText: input.includeText,
    headwords: new Map(headwordRows.map((r) => [r.id, r.headword])),
  });
  const selection = {
    source: sourceSlug,
    lessonFrom: input.lessonFrom ?? null,
    lessonTo: input.lessonTo ?? null,
    match: input.match?.trim() || null,
  };
  const result: LessonReviewResult = { selection, ...review };
  if (review.sessions.length === 0) {
    result.hint =
      sessionRows.length === 0
        ? "No lesson (open-book) sessions match this source and date range. list_sessions shows what is logged."
        : `${sessionRows.length} lesson session(s) match the source and dates, none the lesson range or text filter. Lesson numbers are read from the label (L12) or source_name (12課).`;
  }
  return result;
}
