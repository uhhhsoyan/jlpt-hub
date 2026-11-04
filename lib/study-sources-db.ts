import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { practiceQuestions, practiceSessions, studyLog, studySources, type StudySourceRow } from "@/lib/db/schema";
import { resolveSource } from "@/lib/study-sources";
import type { PracticeSurface, SessionMode, StudyActivity, StudySourceKind } from "@/lib/types";

export { resolveSource, slugify, parseAliases, normalizeSourceText } from "@/lib/study-sources";

/** The whole catalog, display order. Inactive sources are included unless asked otherwise: they still resolve. */
export async function loadStudySources(opts: { activeOnly?: boolean } = {}): Promise<StudySourceRow[]> {
  return getDb()
    .select()
    .from(studySources)
    .where(opts.activeOnly ? eq(studySources.active, true) : undefined)
    .orderBy(asc(studySources.sortOrder), asc(studySources.name));
}

export async function getStudySourceBySlug(slug: string): Promise<StudySourceRow | null> {
  const [row] = await getDb().select().from(studySources).where(eq(studySources.slug, slug));
  return row ?? null;
}

/** Resolve free text (slug, name, alias, or a name followed by detail) to a catalog row. */
export async function resolveSourceText(text: string | null | undefined): Promise<StudySourceRow | null> {
  if (!text?.trim()) return null;
  return resolveSource(await loadStudySources(), text);
}

export interface SourceStats {
  sessions: number;
  practiceSessions: number;
  lessonSessions: number;
  lastSessionAt: string | null;
  logEntries: number;
  minutes: number;
  lastLogAt: string | null;
  /** Latest of the two, for "last used". */
  lastUsedAt: string | null;
}

type SessionStatRow = Record<string, unknown> & {
  source_id: string;
  sessions: string | number;
  practice_sessions: string | number;
  lesson_sessions: string | number;
  last_session_at: string | Date | null;
};

type LogStatRow = Record<string, unknown> & {
  source_id: string;
  entries: string | number;
  minutes: string | number;
  last_log_at: string | Date | null;
};

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  return new Date(v).toISOString();
}

export const EMPTY_STATS: SourceStats = {
  sessions: 0,
  practiceSessions: 0,
  lessonSessions: 0,
  lastSessionAt: null,
  logEntries: 0,
  minutes: 0,
  lastLogAt: null,
  lastUsedAt: null,
};

/** Per-source usage, keyed by source id. Sources with no activity are absent (use EMPTY_STATS). */
export async function getSourceStats(): Promise<Map<string, SourceStats>> {
  const db = getDb();
  const [sessionRes, logRes] = await Promise.all([
    db.execute<SessionStatRow>(sql`
      SELECT source_id,
             count(*) AS sessions,
             count(*) FILTER (WHERE mode = 'practice') AS practice_sessions,
             count(*) FILTER (WHERE mode = 'lesson') AS lesson_sessions,
             max(taken_at) AS last_session_at
      FROM practice_sessions
      WHERE source_id IS NOT NULL
      GROUP BY source_id
    `),
    db.execute<LogStatRow>(sql`
      SELECT source_id,
             count(*) AS entries,
             coalesce(sum(minutes), 0) AS minutes,
             max(taken_at) AS last_log_at
      FROM study_log
      WHERE source_id IS NOT NULL
      GROUP BY source_id
    `),
  ]);

  const stats = new Map<string, SourceStats>();
  const get = (id: string) => {
    const cur = stats.get(id) ?? { ...EMPTY_STATS };
    stats.set(id, cur);
    return cur;
  };
  for (const r of sessionRes.rows) {
    const s = get(r.source_id);
    s.sessions = Number(r.sessions);
    s.practiceSessions = Number(r.practice_sessions);
    s.lessonSessions = Number(r.lesson_sessions);
    s.lastSessionAt = iso(r.last_session_at);
  }
  for (const r of logRes.rows) {
    const s = get(r.source_id);
    s.logEntries = Number(r.entries);
    s.minutes = Number(r.minutes);
    s.lastLogAt = iso(r.last_log_at);
  }
  for (const s of stats.values()) {
    const candidates = [s.lastSessionAt, s.lastLogAt].filter((d): d is string => d !== null).sort();
    s.lastUsedAt = candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }
  return stats;
}

export interface SourceListing {
  slug: string;
  name: string;
  nameJa: string | null;
  kind: StudySourceKind;
  level: string | null;
  edition: string | null;
  url: string | null;
  description: string | null;
  howUsed: string | null;
  aliases: string[];
  active: boolean;
  stats: SourceStats;
}

/** The catalog with usage counts, for the MCP list_sources tool and the Hub grid. */
export async function listStudySources(opts: { includeInactive?: boolean } = {}): Promise<SourceListing[]> {
  const [rows, stats] = await Promise.all([loadStudySources({ activeOnly: !opts.includeInactive }), getSourceStats()]);
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    nameJa: r.nameJa,
    kind: r.kind,
    level: r.level,
    edition: r.edition,
    url: r.url,
    description: r.description,
    howUsed: r.howUsed,
    aliases: r.aliases,
    active: r.active,
    stats: stats.get(r.id) ?? EMPTY_STATS,
  }));
}

export interface LogStudyInput {
  /** Slug, name or alias of a catalog source. Required: a study-log row without a source says nothing useful. */
  source: string;
  activity: StudyActivity;
  minutes?: number | null;
  takenAt: Date;
  note?: string | null;
  meta?: Record<string, unknown> | null;
  surface: PracticeSurface;
}

export interface LogStudyResult {
  id: string;
  source: { slug: string; name: string };
  activity: StudyActivity;
  minutes: number | null;
  takenAt: string;
}

/** Record time-based activity against a source. Throws (listing the slugs) when the source does not resolve. */
export async function logStudy(input: LogStudyInput): Promise<LogStudyResult> {
  const sources = await loadStudySources();
  const source = resolveSource(sources, input.source);
  if (!source) {
    const slugs = sources.filter((s) => s.active).map((s) => s.slug);
    throw new Error(
      `No study source matches "${input.source}". Use one of: ${slugs.join(", ")} (or a name/alias of one; see list_sources).`,
    );
  }
  const minutes = input.minutes == null ? null : Math.max(0, Math.round(input.minutes));
  const [row] = await getDb()
    .insert(studyLog)
    .values({
      sourceId: source.id,
      activity: input.activity,
      minutes,
      takenAt: input.takenAt,
      note: input.note?.trim() || null,
      meta: input.meta && Object.keys(input.meta).length > 0 ? input.meta : null,
      surface: input.surface,
    })
    .returning({ id: studyLog.id });
  return {
    id: row.id,
    source: { slug: source.slug, name: source.name },
    activity: input.activity,
    minutes,
    takenAt: input.takenAt.toISOString(),
  };
}

export interface StudyLogEntry {
  id: string;
  activity: StudyActivity;
  minutes: number | null;
  takenAt: Date;
  note: string | null;
  surface: PracticeSurface;
}

/** A source's study-log entries, newest first. */
export async function listStudyLog(sourceId: string, limit = 50): Promise<StudyLogEntry[]> {
  return getDb()
    .select({
      id: studyLog.id,
      activity: studyLog.activity,
      minutes: studyLog.minutes,
      takenAt: studyLog.takenAt,
      note: studyLog.note,
      surface: studyLog.surface,
    })
    .from(studyLog)
    .where(eq(studyLog.sourceId, sourceId))
    .orderBy(desc(studyLog.takenAt), desc(studyLog.createdAt))
    .limit(limit);
}

export interface SourceSession {
  id: string;
  label: string;
  sourceName: string | null;
  mode: SessionMode;
  status: "review" | "confirmed";
  takenAt: Date;
  graded: number;
  correct: number;
}

/** A source's practice/lesson sessions with scores, newest first. */
export async function listSourceSessions(sourceId: string, limit = 100): Promise<SourceSession[]> {
  const rows = await getDb()
    .select({
      id: practiceSessions.id,
      label: practiceSessions.label,
      sourceName: practiceSessions.sourceName,
      mode: practiceSessions.mode,
      status: practiceSessions.status,
      takenAt: practiceSessions.takenAt,
      graded: sql<number>`count(${practiceQuestions.id}) FILTER (WHERE ${practiceQuestions.isCorrect} IS NOT NULL)`,
      correct: sql<number>`count(${practiceQuestions.id}) FILTER (WHERE ${practiceQuestions.isCorrect})`,
    })
    .from(practiceSessions)
    .leftJoin(practiceQuestions, eq(practiceQuestions.sessionId, practiceSessions.id))
    .where(eq(practiceSessions.sourceId, sourceId))
    .groupBy(practiceSessions.id)
    .orderBy(desc(practiceSessions.takenAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, graded: Number(r.graded), correct: Number(r.correct) }));
}

/** Everything the Hub's add/edit forms can set. Slug is fixed at creation (URLs and MCP calls depend on it). */
export interface StudySourceFields {
  name: string;
  nameJa: string | null;
  kind: StudySourceKind;
  level: string | null;
  edition: string | null;
  url: string | null;
  color: string | null;
  aliases: string[];
  description: string | null;
  howUsed: string | null;
  notes?: string | null;
  active?: boolean;
  sortOrder?: number;
}

export async function createStudySource(slug: string, fields: StudySourceFields): Promise<StudySourceRow> {
  const db = getDb();
  const sortOrder =
    fields.sortOrder ??
    Number((await db.execute<{ next: string | number }>(sql`SELECT coalesce(max(sort_order), 0) + 10 AS next FROM study_sources`)).rows[0]?.next ?? 0);
  const [row] = await db
    .insert(studySources)
    .values({ slug, ...fields, active: fields.active ?? true, sortOrder })
    .returning();
  return row;
}

export async function updateStudySource(
  id: string,
  patch: Partial<StudySourceFields> & { imageUrl?: string | null },
): Promise<StudySourceRow> {
  const [row] = await getDb().update(studySources).set(patch).where(eq(studySources.id, id)).returning();
  if (!row) throw new Error("Source not found.");
  return row;
}
