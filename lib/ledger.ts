import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  insights,
  observations,
  practiceQuestions,
  practiceSessions,
  questionItems,
  studySources,
} from "@/lib/db/schema";
import { matchTag, matchText, suggestItems, type ItemIndex, type ItemSuggestion } from "@/lib/item-match";
import { loadItemIndex, resolveTags } from "@/lib/resolve-items";
import { loadStudySources, resolveSource } from "@/lib/study-sources-db";
import type {
  ExtractedTag,
  InsightSource,
  ObservationKind,
  PracticeSection,
  PracticeSurface,
  QuestionTag,
  SessionMode,
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

/**
 * What kind of evidence an attempt produces. Closed-book practice answers are graded
 * evidence (and only when actually graded); open-book lesson work is exposure, written
 * even when ungraded, so "studied this" moves an item from unseen to learning without
 * touching accuracy anywhere.
 */
export function evidenceKind(mode: SessionMode, correct: boolean | null): ObservationKind | null {
  if (mode === "lesson") return "exposure";
  return correct === null ? null : "answer";
}

export interface AttemptInput {
  /** Printed question number; defaults to position in the batch. */
  number?: number;
  section: PracticeSection;
  level?: StudyLevel | null;
  /** null when the question was skipped or ungradable. */
  correct: boolean | null;
  /** Open vocabulary; see normalizeRootCause in lib/types.ts. */
  rootCause?: string | null;
  note?: string | null;
  stem?: string | null;
  choices?: string[];
  explanation?: string | null;
  tags: ExtractedTag[];
  /** Anything structured that has no field of its own; stored as-is on the question. */
  meta?: Record<string, unknown> | null;
}

export interface LogAttemptsInput {
  label: string;
  /**
   * Catalog source (slug, name or alias; see lib/study-sources.ts). Resolved first; when
   * absent, sourceName is tried against the catalog too, so "Shin Nihongo 500 Mon N4-N5"
   * links the session without a separate field.
   */
  source?: string | null;
  /** Free text kept on the session: the book when `source` is absent, or the detail (lesson, page). */
  sourceName?: string | null;
  takenAt: Date;
  surface: PracticeSurface;
  /** Defaults to practice (closed book). See SessionMode in lib/types.ts. */
  mode?: SessionMode;
  timed?: boolean | null;
  /** Photo references (Blob URLs or free text like "claude.ai thread 2026-10-27"). */
  imageRefs?: string[];
  attempts: AttemptInput[];
}

export interface UnresolvedTag {
  number: number;
  kind: ExtractedTag["kind"];
  text: string;
  /** Closest library items, so the caller can re-tag without a separate lookup. */
  suggestions: ItemSuggestion[];
}

export interface LogAttemptsResult {
  sessionId: string;
  mode: SessionMode;
  questions: number;
  graded: number;
  correct: number;
  /** Evidence rows written: graded answers for practice, exposures for a lesson. */
  observations: number;
  /**
   * Tags that matched no library item. The tag text is kept on the question, so once the
   * item exists (or gains an alias) `relink_tags` attaches the evidence retroactively.
   * Each suggestion carries `match`; "prefix-only" is a shorter, different item, not a hit.
   */
  unresolvedTags: UnresolvedTag[];
  /** The catalog source the session was linked to, or null. */
  source: { slug: string; name: string } | null;
  /** Set when `source` / `source_name` was given but matched no catalog entry (the text is still kept on the session). */
  sourceUnresolved?: string;
}

function unresolvedWithSuggestions(index: ItemIndex, number: number, tag: QuestionTag): UnresolvedTag {
  return {
    number,
    kind: tag.kind,
    text: tag.text,
    suggestions: suggestItems(index, tag.text, { kind: tag.kind, limit: 3 }),
  };
}

export async function logAttempts(input: LogAttemptsInput): Promise<LogAttemptsResult> {
  if (input.attempts.length === 0) throw new Error("No attempts to log.");
  const db = getDb();
  const mode: SessionMode = input.mode ?? "practice";

  const [index, sources] = await Promise.all([loadItemIndex(), loadStudySources()]);
  const allTags = input.attempts.flatMap((a) => a.tags);
  const resolved = await resolveTags(allTags, index);
  let cursor = 0;
  const attempts = input.attempts.map((a, i) => {
    const tags: QuestionTag[] = resolved.slice(cursor, cursor + a.tags.length);
    cursor += a.tags.length;
    return { ...a, number: a.number ?? i + 1, tags };
  });

  // Explicit `source` first, else the free-text source name; whichever was tried and
  // failed is reported back so the caller can fix the alias rather than lose the link.
  const sourceText = input.source?.trim() || input.sourceName?.trim() || null;
  const source = sourceText ? resolveSource(sources, sourceText) : null;
  const sourceUnresolved = sourceText && !source ? sourceText : undefined;

  const [session] = await db
    .insert(practiceSessions)
    .values({
      label: input.label,
      sourceId: source?.id ?? null,
      sourceName: input.sourceName?.trim() || null,
      status: "confirmed",
      surface: input.surface,
      mode,
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
        meta: a.meta && Object.keys(a.meta).length > 0 ? a.meta : null,
      })
      .returning({ id: practiceQuestions.id });

    if (a.correct !== null) {
      graded += 1;
      if (a.correct) correct += 1;
    }

    const kind = evidenceKind(mode, a.correct);
    for (const tag of a.tags) {
      if (!tag.itemId) {
        unresolvedTags.push(unresolvedWithSuggestions(index, a.number, tag));
        continue;
      }
      itemRows.push({ questionId: row.id, itemId: tag.itemId, role: "tested" });
      if (kind) {
        obsRows.push({
          itemId: tag.itemId,
          source: "practice",
          kind,
          correct: a.correct,
          occurredAt: input.takenAt,
          meta: { sessionId, questionId: row.id, surface: input.surface, mode },
        });
      }
    }
  }

  if (itemRows.length > 0) await db.insert(questionItems).values(itemRows);
  if (obsRows.length > 0) await db.insert(observations).values(obsRows);

  return {
    sessionId,
    mode,
    questions: attempts.length,
    graded,
    correct,
    observations: obsRows.length,
    unresolvedTags,
    source: source ? { slug: source.slug, name: source.name } : null,
    ...(sourceUnresolved ? { sourceUnresolved } : {}),
  };
}

export interface LogInsightInput {
  text: string;
  tags?: string[];
  /** Optional item references, resolved against the library like question tags. */
  items?: ExtractedTag[];
  source: InsightSource;
}

export interface UnresolvedItem extends ExtractedTag {
  suggestions: ItemSuggestion[];
}

export interface LogInsightResult {
  id: string;
  linkedItems: number;
  /** Kept on the insight; `relink_tags` attaches them once the library has a match. */
  unresolvedItems: UnresolvedItem[];
}

export async function logInsight(input: LogInsightInput): Promise<LogInsightResult> {
  const text = input.text.trim();
  if (!text) throw new Error("Insight text is empty.");
  const index = await loadItemIndex();
  const resolved = input.items?.length ? await resolveTags(input.items, index) : [];
  const itemIds = resolved.filter((t) => t.itemId).map((t) => t.itemId as string);
  const unresolvedItems = resolved
    .filter((t) => !t.itemId)
    .map(({ kind, text }) => ({ kind, text, suggestions: suggestItems(index, text, { kind, limit: 3 }) }));

  const [row] = await getDb()
    .insert(insights)
    .values({
      text,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      itemIds,
      items: resolved,
      source: input.source,
    })
    .returning({ id: insights.id });
  return { id: row.id, linkedItems: itemIds.length, unresolvedItems };
}

export interface InsightSummary {
  id: string;
  text: string;
  tags: string[];
  /** Headwords of the linked library items. */
  items: string[];
  source: InsightSource;
  createdAt: string;
}

/**
 * Newest first. `topic` matches the text (case-insensitive substring), an exact tag, or a
 * library item (headword, alias, reading or loosened pattern) the insight is linked to.
 */
export async function getInsights(opts: { topic?: string; limit?: number } = {}): Promise<InsightSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const topic = opts.topic?.trim();
  const db = getDb();
  const index = await loadItemIndex();
  const topicItemId = topic ? matchText(index, topic) : null;
  const rows = await db
    .select()
    .from(insights)
    .where(
      topic
        ? sql`(${insights.text} ILIKE ${"%" + topic + "%"} OR ${insights.tags} @> ${JSON.stringify([topic])}::jsonb${
            topicItemId ? sql` OR ${insights.itemIds} @> ${JSON.stringify([topicItemId])}::jsonb` : sql``
          })`
        : undefined,
    )
    .orderBy(desc(insights.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    tags: r.tags,
    items: r.itemIds.map((id) => index.byId.get(id)?.headword ?? id),
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Every tag ever used on an insight with its count, so a logging surface can reuse vocabulary. */
export async function getInsightTagCounts(): Promise<{ tag: string; n: number }[]> {
  const res = await getDb().execute<Record<string, unknown> & { tag: string; n: string | number }>(sql`
    SELECT tag, count(*) AS n
    FROM insights, jsonb_array_elements_text(tags) AS tag
    GROUP BY tag
    ORDER BY n DESC, tag ASC
  `);
  return res.rows.map((r) => ({ tag: r.tag, n: Number(r.n) }));
}

export interface SessionSummary {
  id: string;
  label: string;
  /** Catalog source the session is linked to (see list_sources), or null. */
  source: { slug: string; name: string } | null;
  sourceName: string | null;
  surface: PracticeSurface;
  mode: SessionMode;
  status: "review" | "confirmed";
  takenAt: string;
  graded: number;
  correct: number;
}

/** Most recent sessions with their scores, for an MCP client to see what is already logged. */
export async function listSessions(limit = 10, id?: string): Promise<SessionSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: practiceSessions.id,
      label: practiceSessions.label,
      sourceSlug: studySources.slug,
      sourceDisplayName: studySources.name,
      sourceName: practiceSessions.sourceName,
      surface: practiceSessions.surface,
      mode: practiceSessions.mode,
      status: practiceSessions.status,
      takenAt: practiceSessions.takenAt,
      graded: sql<number>`count(${practiceQuestions.id}) FILTER (WHERE ${practiceQuestions.isCorrect} IS NOT NULL)`,
      correct: sql<number>`count(${practiceQuestions.id}) FILTER (WHERE ${practiceQuestions.isCorrect})`,
    })
    .from(practiceSessions)
    .leftJoin(practiceQuestions, eq(practiceQuestions.sessionId, practiceSessions.id))
    .leftJoin(studySources, eq(studySources.id, practiceSessions.sourceId))
    .where(id ? eq(practiceSessions.id, id) : undefined)
    .groupBy(practiceSessions.id, studySources.slug, studySources.name)
    .orderBy(desc(practiceSessions.takenAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(({ sourceSlug, sourceDisplayName, ...r }) => ({
    ...r,
    source: sourceSlug && sourceDisplayName ? { slug: sourceSlug, name: sourceDisplayName } : null,
    takenAt: r.takenAt.toISOString(),
    graded: Number(r.graded),
    correct: Number(r.correct),
  }));
}

export interface UpdateSessionInput {
  sessionId: string;
  mode?: SessionMode;
  label?: string;
  takenAt?: Date;
  /** Catalog source: slug, name or alias; the string "none" unlinks the session. */
  source?: string;
}

export interface UpdateSessionResult {
  session: SessionSummary;
  /** Which of mode / label / taken_at / source actually changed (unchanged values are skipped). */
  changed: string[];
  /** Evidence rows rewritten when mode or taken_at changed; null when neither did. */
  observations: { removed: number; written: number } | null;
}

type LinkedQuestionRow = Record<string, unknown> & { question_id: string; item_id: string; is_correct: boolean | null };

/**
 * Correct a session logged with the wrong mode, label or date, instead of re-logging it.
 * Questions, tags, notes and insights are untouched. When mode or taken_at changes, the
 * session's observations are rebuilt from its question_items with the new values, so a
 * practice session turned lesson stops counting toward accuracy (and vice versa).
 */
export async function updateSession(input: UpdateSessionInput): Promise<UpdateSessionResult> {
  const db = getDb();
  const [current] = await db.select().from(practiceSessions).where(eq(practiceSessions.id, input.sessionId));
  if (!current) throw new Error(`No session with id ${input.sessionId}.`);

  const patch: Partial<typeof practiceSessions.$inferInsert> = {};
  const changed: string[] = [];
  if (input.mode !== undefined && input.mode !== current.mode) {
    patch.mode = input.mode;
    changed.push("mode");
  }
  const label = input.label?.trim();
  if (label && label !== current.label) {
    patch.label = label;
    changed.push("label");
  }
  if (input.takenAt !== undefined && input.takenAt.getTime() !== current.takenAt.getTime()) {
    patch.takenAt = input.takenAt;
    changed.push("taken_at");
  }
  const sourceText = input.source?.trim();
  if (sourceText) {
    let sourceId: string | null;
    if (sourceText.toLowerCase() === "none") sourceId = null;
    else {
      const sources = await loadStudySources();
      const match = resolveSource(sources, sourceText);
      if (!match) {
        throw new Error(
          `No study source matches "${sourceText}". Use a slug from list_sources (${sources
            .filter((s) => s.active)
            .map((s) => s.slug)
            .join(", ")}) or "none" to unlink.`,
        );
      }
      sourceId = match.id;
    }
    if (sourceId !== current.sourceId) {
      patch.sourceId = sourceId;
      changed.push("source");
    }
  }
  if (changed.length > 0) await db.update(practiceSessions).set(patch).where(eq(practiceSessions.id, current.id));

  let obs: UpdateSessionResult["observations"] = null;
  if (changed.includes("mode") || changed.includes("taken_at")) {
    const mode = patch.mode ?? current.mode;
    const occurredAt = patch.takenAt ?? current.takenAt;
    const removed = await db.execute(sql`
      DELETE FROM observations WHERE source = 'practice' AND meta->>'sessionId' = ${current.id} RETURNING id
    `);
    const links = await db.execute<LinkedQuestionRow>(sql`
      SELECT qi.question_id, qi.item_id, q.is_correct
      FROM question_items qi
      JOIN practice_questions q ON q.id = qi.question_id
      WHERE q.session_id = ${current.id} AND qi.role = 'tested'
    `);
    const obsRows: (typeof observations.$inferInsert)[] = [];
    for (const l of links.rows) {
      const kind = evidenceKind(mode, l.is_correct);
      if (!kind) continue;
      obsRows.push({
        itemId: l.item_id,
        source: "practice",
        kind,
        correct: l.is_correct,
        occurredAt,
        meta: { sessionId: current.id, questionId: l.question_id, surface: current.surface, mode, rebuilt: true },
      });
    }
    if (obsRows.length > 0) await db.insert(observations).values(obsRows);
    obs = { removed: removed.rows.length, written: obsRows.length };
  }

  const session = (await listSessions(1, current.id))[0];
  return { session, changed, observations: obs };
}

export interface RelinkResult {
  questionsChecked: number;
  tagsRelinked: number;
  observations: number;
  insightsChecked: number;
  insightItemsRelinked: number;
  /** Distinct tag texts that still match nothing, with how often they occur. */
  stillUnresolved: { kind: ExtractedTag["kind"]; text: string; n: number; suggestions: ItemSuggestion[] }[];
}

type UnresolvedQuestionRow = Record<string, unknown> & {
  id: string;
  session_id: string;
  is_correct: boolean | null;
  tags: QuestionTag[];
  mode: SessionMode;
  surface: PracticeSurface;
  taken_at: string | Date;
};

/**
 * Re-run resolution over every stored tag that has no item yet (questions and insights)
 * and attach the evidence that was skipped at log time. Idempotent: only tags whose
 * itemId is still null are touched, so running it twice writes nothing the second time.
 * This is what makes "capture first, classify later" true for item links: seed the
 * missing item or add an alias, then relink.
 */
export async function relinkUnresolved(): Promise<RelinkResult> {
  const db = getDb();
  const index = await loadItemIndex();

  const qRes = await db.execute<UnresolvedQuestionRow>(sql`
    SELECT q.id, q.session_id, q.is_correct, q.tags, s.mode, s.surface, s.taken_at
    FROM practice_questions q
    JOIN practice_sessions s ON s.id = q.session_id
    WHERE s.status = 'confirmed'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.tags) t WHERE t->>'itemId' IS NULL)
  `);

  const itemRows: { questionId: string; itemId: string; role: "tested" }[] = [];
  const obsRows: (typeof observations.$inferInsert)[] = [];
  const still = new Map<string, { kind: ExtractedTag["kind"]; text: string; n: number }>();
  let tagsRelinked = 0;

  for (const q of qRes.rows) {
    let changed = false;
    const newTags = q.tags.map((tag) => {
      if (tag.itemId) return tag;
      const itemId = matchTag(index, tag);
      if (!itemId) {
        const key = `${tag.kind}:${tag.text.trim()}`;
        const entry = still.get(key) ?? { kind: tag.kind, text: tag.text.trim(), n: 0 };
        entry.n += 1;
        still.set(key, entry);
        return tag;
      }
      changed = true;
      tagsRelinked += 1;
      itemRows.push({ questionId: q.id, itemId, role: "tested" });
      const kind = evidenceKind(q.mode, q.is_correct);
      if (kind) {
        obsRows.push({
          itemId,
          source: "practice",
          kind,
          correct: q.is_correct,
          occurredAt: new Date(q.taken_at),
          meta: { sessionId: q.session_id, questionId: q.id, surface: q.surface, mode: q.mode, relinked: true },
        });
      }
      return { ...tag, itemId };
    });
    if (changed) await db.update(practiceQuestions).set({ tags: newTags }).where(eq(practiceQuestions.id, q.id));
  }
  if (itemRows.length > 0) await db.insert(questionItems).values(itemRows).onConflictDoNothing();
  if (obsRows.length > 0) await db.insert(observations).values(obsRows);

  const iRes = await db.execute<Record<string, unknown> & { id: string; items: QuestionTag[]; item_ids: string[] }>(sql`
    SELECT id, items, item_ids
    FROM insights
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(items) t WHERE t->>'itemId' IS NULL)
  `);
  let insightItemsRelinked = 0;
  for (const row of iRes.rows) {
    let changed = false;
    const ids = new Set(row.item_ids);
    const newItems = row.items.map((tag) => {
      if (tag.itemId) return tag;
      const itemId = matchTag(index, tag);
      if (!itemId) {
        const key = `${tag.kind}:${tag.text.trim()}`;
        const entry = still.get(key) ?? { kind: tag.kind, text: tag.text.trim(), n: 0 };
        entry.n += 1;
        still.set(key, entry);
        return tag;
      }
      changed = true;
      insightItemsRelinked += 1;
      ids.add(itemId);
      return { ...tag, itemId };
    });
    if (changed) {
      await db.update(insights).set({ items: newItems, itemIds: [...ids] }).where(eq(insights.id, row.id));
    }
  }

  return {
    questionsChecked: qRes.rows.length,
    tagsRelinked,
    observations: obsRows.length,
    insightsChecked: iRes.rows.length,
    insightItemsRelinked,
    stillUnresolved: [...still.values()]
      .sort((a, b) => b.n - a.n)
      .map((u) => ({ ...u, suggestions: suggestItems(index, u.text, { kind: u.kind, limit: 3 }) })),
  };
}
