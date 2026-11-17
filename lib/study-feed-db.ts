import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { insights, practiceQuestions, practiceSessions, studyLog, studySources, vocabQueue } from "@/lib/db/schema";
import {
  assembleStudyFeed,
  feedDay,
  feedWindow,
  NO_FILTER,
  olderBounds,
  olderDay,
  windowBounds,
  type FeedFilter,
  type FeedSource,
  type StudyFeed,
} from "@/lib/study-feed";

export interface LoadStudyFeedInput {
  /** Newest day to show (YYYY-MM-DD); today when absent. */
  to?: string | null;
  filter?: FeedFilter;
  /** Defaults to the current instant (tests and scripts pass a fixed one). */
  now?: Date;
}

/** Longest stem kept for a miss: enough to recognise the sentence, never a whole passage. */
const STEM_CHARS = 160;

const sourceColumns = {
  slug: studySources.slug,
  name: studySources.name,
  nameJa: studySources.nameJa,
  color: studySources.color,
  imageUrl: studySources.imageUrl,
};

function toSource(r: { slug: string | null; name: string | null; nameJa: string | null; color: string | null; imageUrl: string | null }): FeedSource | null {
  return r.slug && r.name ? { slug: r.slug, name: r.name, nameJa: r.nameJa, color: r.color, imageUrl: r.imageUrl } : null;
}

type OlderRow = Record<string, unknown> & { bare: string | Date | null; timed: string | Date | null };

const asDate = (v: string | Date | null): Date | null => (v == null ? null : new Date(v));

/**
 * The study journal for one window of days: SELECTs only, six queries in parallel whatever
 * the window holds (sessions, their attempts, study log, insights, vocab queue, and the
 * newest activity before the window for the "older" link). Attempts carry only what the
 * feed renders: the stem for misses (trimmed), never choices or explanations. Assembly,
 * date bucketing and filters live in lib/study-feed.ts.
 */
export async function loadStudyFeed(input: LoadStudyFeedInput = {}): Promise<StudyFeed> {
  const db = getDb();
  const today = feedDay(input.now ?? new Date());
  const window = feedWindow(input.to, today);
  const { start, end } = windowBounds(window);
  const bounds = olderBounds(window);
  const bareBefore = bounds.bareBefore.toISOString();
  const timedBefore = bounds.timedBefore.toISOString();
  const sessionInWindow = and(gte(practiceSessions.takenAt, start), lt(practiceSessions.takenAt, end));

  const [sessionRows, questionRows, logRows, insightRows, queueRows, olderRes] = await Promise.all([
    db
      .select({
        id: practiceSessions.id,
        label: practiceSessions.label,
        sourceName: practiceSessions.sourceName,
        mode: practiceSessions.mode,
        status: practiceSessions.status,
        timed: practiceSessions.timed,
        takenAt: practiceSessions.takenAt,
        createdAt: practiceSessions.createdAt,
        ...sourceColumns,
      })
      .from(practiceSessions)
      .leftJoin(studySources, eq(studySources.id, practiceSessions.sourceId))
      .where(sessionInWindow),
    db
      .select({
        sessionId: practiceQuestions.sessionId,
        number: practiceQuestions.number,
        isCorrect: practiceQuestions.isCorrect,
        rootCause: practiceQuestions.rootCause,
        note: practiceQuestions.note,
        tags: practiceQuestions.tags,
        meta: practiceQuestions.meta,
        stem: sql<string | null>`CASE WHEN ${practiceQuestions.isCorrect} = false THEN left(${practiceQuestions.stem}, ${STEM_CHARS}) END`,
      })
      .from(practiceQuestions)
      .innerJoin(practiceSessions, eq(practiceSessions.id, practiceQuestions.sessionId))
      .where(sessionInWindow)
      .orderBy(asc(practiceQuestions.number), asc(practiceQuestions.createdAt)),
    db
      .select({
        id: studyLog.id,
        activity: studyLog.activity,
        minutes: studyLog.minutes,
        note: studyLog.note,
        takenAt: studyLog.takenAt,
        createdAt: studyLog.createdAt,
        ...sourceColumns,
      })
      .from(studyLog)
      .leftJoin(studySources, eq(studySources.id, studyLog.sourceId))
      .where(and(gte(studyLog.takenAt, start), lt(studyLog.takenAt, end))),
    db
      .select({ id: insights.id, text: insights.text, tags: insights.tags, items: insights.items, createdAt: insights.createdAt })
      .from(insights)
      .where(and(gte(insights.createdAt, start), lt(insights.createdAt, end))),
    db
      .select({ id: vocabQueue.id, text: vocabQueue.text, reading: vocabQueue.reading, sightings: vocabQueue.sightings })
      .from(vocabQueue)
      .where(and(lt(vocabQueue.firstSeenAt, end), gte(vocabQueue.lastSeenAt, start))),
    // Newest bare date and newest real time before the window, across every kind of entry.
    // "Bare" is the same test as isDateOnly: exactly UTC midnight.
    db.execute<OlderRow>(sql`
      WITH t(ts) AS (
        SELECT taken_at FROM practice_sessions WHERE taken_at < ${timedBefore}::timestamptz
        UNION ALL SELECT taken_at FROM study_log WHERE taken_at < ${timedBefore}::timestamptz
        UNION ALL SELECT created_at FROM insights WHERE created_at < ${timedBefore}::timestamptz
        UNION ALL
          SELECT (s->>'at')::timestamptz
          FROM vocab_queue, jsonb_array_elements(sightings) AS s
          WHERE first_seen_at < ${timedBefore}::timestamptz AND s->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      )
      SELECT max(ts) FILTER (WHERE ts = date_trunc('day', ts, 'UTC') AND ts < ${bareBefore}::timestamptz) AS bare,
             max(ts) FILTER (WHERE ts <> date_trunc('day', ts, 'UTC') AND ts < ${timedBefore}::timestamptz) AS timed
      FROM t
    `),
  ]);

  const older = olderRes.rows[0];
  return assembleStudyFeed(
    {
      sessions: sessionRows.map((r) => ({
        id: r.id,
        label: r.label,
        sourceName: r.sourceName,
        mode: r.mode,
        status: r.status,
        timed: r.timed,
        takenAt: r.takenAt,
        createdAt: r.createdAt,
        source: toSource(r),
      })),
      questions: questionRows,
      studyLogs: logRows.map((r) => ({
        id: r.id,
        activity: r.activity,
        minutes: r.minutes,
        note: r.note,
        takenAt: r.takenAt,
        createdAt: r.createdAt,
        source: toSource(r),
      })),
      insights: insightRows,
      queue: queueRows,
    },
    {
      window,
      today,
      filter: input.filter ?? NO_FILTER,
      older: older ? olderDay([asDate(older.bare), asDate(older.timed)], window) : null,
    },
  );
}
