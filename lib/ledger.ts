import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  insights,
  observations,
  practiceQuestions,
  practiceSessions,
  questionItems,
} from "@/lib/db/schema";
import { resolveTags } from "@/lib/resolve-items";
import type {
  ExtractedTag,
  InsightSource,
  PracticeSection,
  PracticeSurface,
  QuestionTag,
  RootCause,
  StudyLevel,
} from "@/lib/types";

/**
 * The study ledger's write path, shared by the MCP tools (app/mcp/route.ts) and
 * anything else that logs graded questions without going through the photo-upload
 * flow. Sessions logged here land as `confirmed`: the human review happened in the
 * conversation that produced them (page photo + voiceover), so there is nothing left
 * to stage. Observations are written exactly the way confirmSession writes them
 * (source='practice', meta.sessionId) so the purge/re-confirm paths keep working.
 */

/** Accepts the Hub's section names and the JLPT/Japanese ones the study notes use. */
const SECTION_ALIASES: Record<string, PracticeSection> = {
  kanji: "kanji",
  moji: "kanji",
  文字: "kanji",
  vocab: "vocab",
  vocabulary: "vocab",
  goi: "vocab",
  語彙: "vocab",
  grammar: "grammar",
  bunpou: "grammar",
  bunpo: "grammar",
  bunpoo: "grammar",
  文法: "grammar",
  reading: "reading",
  dokkai: "reading",
  読解: "reading",
  listening: "listening",
  choukai: "listening",
  chokai: "listening",
  聴解: "listening",
  other: "other",
};

export function normalizeSection(raw: string): PracticeSection | null {
  return SECTION_ALIASES[raw.trim().toLowerCase()] ?? SECTION_ALIASES[raw.trim()] ?? null;
}

export interface AttemptInput {
  /** Printed question number; defaults to position in the batch. */
  number?: number;
  section: PracticeSection;
  level?: StudyLevel | null;
  /** null when the question was skipped or ungradable. */
  correct: boolean | null;
  rootCause?: RootCause | null;
  note?: string | null;
  stem?: string | null;
  choices?: string[];
  explanation?: string | null;
  tags: ExtractedTag[];
}

export interface LogAttemptsInput {
  label: string;
  sourceName?: string | null;
  takenAt: Date;
  surface: PracticeSurface;
  timed?: boolean | null;
  /** Photo references (Blob URLs or free text like "claude.ai thread 2026-10-27"). */
  imageRefs?: string[];
  attempts: AttemptInput[];
}

export interface UnresolvedTag {
  number: number;
  kind: ExtractedTag["kind"];
  text: string;
}

export interface LogAttemptsResult {
  sessionId: string;
  questions: number;
  graded: number;
  correct: number;
  observations: number;
  /** Tags that matched no library item: no evidence was written for them. */
  unresolvedTags: UnresolvedTag[];
}

export async function logAttempts(input: LogAttemptsInput): Promise<LogAttemptsResult> {
  if (input.attempts.length === 0) throw new Error("No attempts to log.");
  const db = getDb();

  const allTags = input.attempts.flatMap((a) => a.tags);
  const resolved = await resolveTags(allTags);
  let cursor = 0;
  const attempts = input.attempts.map((a, i) => {
    const tags: QuestionTag[] = resolved.slice(cursor, cursor + a.tags.length);
    cursor += a.tags.length;
    return { ...a, number: a.number ?? i + 1, tags };
  });

  const [session] = await db
    .insert(practiceSessions)
    .values({
      label: input.label,
      sourceName: input.sourceName ?? null,
      status: "confirmed",
      surface: input.surface,
      timed: input.timed ?? null,
      imagePaths: input.imageRefs ?? [],
      takenAt: input.takenAt,
    })
    .returning({ id: practiceSessions.id });
  const sessionId = session.id;

  // One insert per question so each returned id is unambiguously tied to its own tags
  // (same reasoning as app/practice/actions.ts createSession).
  const itemRows: { questionId: string; itemId: string; role: "tested" }[] = [];
  const obsRows: (typeof observations.$inferInsert)[] = [];
  const unresolvedTags: UnresolvedTag[] = [];
  let graded = 0;
  let correct = 0;

  for (const a of attempts) {
    const [row] = await db
      .insert(practiceQuestions)
      .values({
        sessionId,
        number: a.number,
        section: a.section,
        stem: a.stem ?? "",
        choices: a.choices ?? [],
        correctChoice: null,
        userChoice: null,
        isCorrect: a.correct,
        explanation: a.explanation || null,
        tags: a.tags,
        level: a.level ?? null,
        rootCause: a.rootCause ?? null,
        note: a.note || null,
      })
      .returning({ id: practiceQuestions.id });

    if (a.correct !== null) {
      graded += 1;
      if (a.correct) correct += 1;
    }

    for (const tag of a.tags) {
      if (!tag.itemId) {
        unresolvedTags.push({ number: a.number, kind: tag.kind, text: tag.text });
        continue;
      }
      itemRows.push({ questionId: row.id, itemId: tag.itemId, role: "tested" });
      if (a.correct !== null) {
        obsRows.push({
          itemId: tag.itemId,
          source: "practice",
          kind: "answer",
          correct: a.correct,
          occurredAt: input.takenAt,
          meta: { sessionId, questionId: row.id, surface: input.surface },
        });
      }
    }
  }

  if (itemRows.length > 0) await db.insert(questionItems).values(itemRows);
  if (obsRows.length > 0) await db.insert(observations).values(obsRows);

  return {
    sessionId,
    questions: attempts.length,
    graded,
    correct,
    observations: obsRows.length,
    unresolvedTags,
  };
}

export interface LogInsightInput {
  text: string;
  tags?: string[];
  /** Optional item references, resolved against the library like question tags. */
  items?: ExtractedTag[];
  source: InsightSource;
}

export async function logInsight(input: LogInsightInput): Promise<{ id: string; unresolvedItems: ExtractedTag[] }> {
  const text = input.text.trim();
  if (!text) throw new Error("Insight text is empty.");
  const resolved = input.items?.length ? await resolveTags(input.items) : [];
  const itemIds = resolved.filter((t) => t.itemId).map((t) => t.itemId as string);
  const unresolvedItems = resolved.filter((t) => !t.itemId).map(({ kind, text }) => ({ kind, text }));

  const [row] = await getDb()
    .insert(insights)
    .values({
      text,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      itemIds,
      source: input.source,
    })
    .returning({ id: insights.id });
  return { id: row.id, unresolvedItems };
}

export interface InsightSummary {
  id: string;
  text: string;
  tags: string[];
  source: InsightSource;
  createdAt: string;
}

/** Newest first; `topic` matches text (case-insensitive substring) or an exact tag. */
export async function getInsights(opts: { topic?: string; limit?: number } = {}): Promise<InsightSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const topic = opts.topic?.trim();
  const db = getDb();
  const rows = await db
    .select()
    .from(insights)
    .where(
      topic
        ? sql`(${insights.text} ILIKE ${"%" + topic + "%"} OR ${insights.tags} @> ${JSON.stringify([topic])}::jsonb)`
        : undefined,
    )
    .orderBy(desc(insights.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    tags: r.tags,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface SessionSummary {
  id: string;
  label: string;
  sourceName: string | null;
  surface: PracticeSurface;
  status: "review" | "confirmed";
  takenAt: string;
  graded: number;
  correct: number;
}

/** Most recent sessions with their scores, for an MCP client to see what is already logged. */
export async function listSessions(limit = 10): Promise<SessionSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: practiceSessions.id,
      label: practiceSessions.label,
      sourceName: practiceSessions.sourceName,
      surface: practiceSessions.surface,
      status: practiceSessions.status,
      takenAt: practiceSessions.takenAt,
      graded: sql<number>`count(${practiceQuestions.id}) FILTER (WHERE ${practiceQuestions.isCorrect} IS NOT NULL)`,
      correct: sql<number>`count(${practiceQuestions.id}) FILTER (WHERE ${practiceQuestions.isCorrect})`,
    })
    .from(practiceSessions)
    .leftJoin(practiceQuestions, eq(practiceQuestions.sessionId, practiceSessions.id))
    .groupBy(practiceSessions.id)
    .orderBy(desc(practiceSessions.takenAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => ({
    ...r,
    takenAt: r.takenAt.toISOString(),
    graded: Number(r.graded),
    correct: Number(r.correct),
  }));
}
