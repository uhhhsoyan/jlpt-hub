import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  insights,
  observations,
  practiceQuestions,
  practiceSessions,
  questionItems,
  studySources,
  type PracticeQuestionRow,
  type PracticeSessionRow,
} from "@/lib/db/schema";
import { matchTag, suggestItems, topicItemIds, type ItemIndex, type ItemSuggestion } from "@/lib/item-match";
import { rankInsights, type InsightMatch } from "@/lib/insight-match";
import { loadItemIndex, resolveTags } from "@/lib/resolve-items";
import { loadStudySources, resolveSource } from "@/lib/study-sources-db";
import {
  queueVocab,
  relinkVocabQueue,
  type QueueContext,
  type QueueVocabResult,
  type VocabGapEntry,
  type VocabGapInput,
} from "@/lib/vocab-queue";
import {
  buildAttemptMeta,
  buildEvidenceRows,
  evidenceKind,
  findPartClash,
  groupUnresolved,
  linkedItemIds,
  pickAttempt,
  planAttemptPatch,
  unresolvedOccurrences,
  describeAttempt,
  type AttemptSelector,
  type EvidenceRow,
  type UnresolvedOccurrence,
} from "@/lib/ledger-core";
import { attemptName, evidenceDate, readDoneOn, readPart, readSlips, type Slip } from "@/lib/attempt-meta";
import type {
  ExtractedTag,
  InsightSource,
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

/** Pure, so it lives in lib/ledger-core.ts (unit-tested there); re-exported for existing callers. */
export { evidenceKind };

export interface AttemptInput {
  /** Printed question number; defaults to position in the batch. */
  number?: number;
  /** Blank of a multi-blank question (number 7, part 1 and part 2); stored at meta.questionPart. */
  part?: number;
  /** Already validated (parseDoneOn): the day this attempt was done when it differs from taken_at; stored at meta.done_on. */
  doneOn?: string;
  /** Already normalised (normalizeSlips); stored at meta.slips. Never evidence, never accuracy. */
  slips?: Slip[];
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
  /** Anything structured that has no field of its own; stored as-is on the question (part/done_on/slips keys not allowed). */
  meta?: Record<string, unknown> | null;
  /** Words the learner did not know while doing this question, right or wrong; each goes on the vocab queue. */
  vocabGaps?: VocabGapInput[];
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

/** One distinct tag text that matched no library item, with every attempt number it was on. */
export interface UnresolvedTag {
  kind: ExtractedTag["kind"];
  text: string;
  /** Printed numbers of the attempts carrying this tag (several when a lesson repeats a missing pattern). */
  numbers: number[];
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
  /** Vocab-queue rows created or bumped from the attempts' vocab_gaps. */
  vocabQueued: number;
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

/** Group unresolved tag occurrences by {kind, text} and attach one suggestions block per group. */
function unresolvedWithSuggestions(index: ItemIndex, occurrences: UnresolvedOccurrence[]): UnresolvedTag[] {
  return groupUnresolved(occurrences).map((g) => ({
    ...g,
    suggestions: suggestItems(index, g.text, { kind: g.kind, limit: 3 }),
  }));
}

export async function logAttempts(input: LogAttemptsInput): Promise<LogAttemptsResult> {
  if (input.attempts.length === 0) throw new Error("No attempts to log.");
  const clash = findPartClash(input.attempts.map((a, i) => ({ number: a.number ?? i + 1, part: a.part ?? null })));
  if (clash) {
    const a = input.attempts[clash.first];
    throw new Error(
      `Attempts ${clash.first + 1} and ${clash.second + 1} are both ${attemptName(a.number ?? clash.first + 1, a.part ?? null)}; each blank of a question is one entry with its own part.`,
    );
  }
  const db = getDb();
  const mode: SessionMode = input.mode ?? "practice";

  const [index, sources] = await Promise.all([loadItemIndex(), loadStudySources()]);
  const allTags = input.attempts.flatMap((a) => a.tags);
  const resolved = await resolveTags(allTags, index);
  let cursor = 0;
  const attempts = input.attempts.map((a, i) => {
    const tags: QuestionTag[] = resolved.slice(cursor, cursor + a.tags.length);
    cursor += a.tags.length;
    const meta = buildAttemptMeta(a.meta, { part: a.part, doneOn: a.doneOn, slips: a.slips });
    const number = a.number ?? i + 1;
    return { ...a, number, tags, meta, occurredAt: evidenceDate(meta, input.takenAt, `Attempt ${attemptName(number, a.part ?? null)}`) };
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
  const unresolved: UnresolvedOccurrence[] = [];
  const gapEntries: VocabGapEntry[] = [];
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
        meta: a.meta,
      })
      .returning({ id: practiceQuestions.id });

    for (const g of a.vocabGaps ?? []) {
      gapEntries.push({ ...g, context: g.context ?? a.note ?? a.stem ?? null, questionId: row.id });
    }

    if (a.correct !== null) {
      graded += 1;
      if (a.correct) correct += 1;
    }

    const kind = evidenceKind(mode, a.correct);
    for (const tag of a.tags) {
      if (!tag.itemId) {
        unresolved.push({ number: a.number, kind: tag.kind, text: tag.text });
        continue;
      }
      itemRows.push({ questionId: row.id, itemId: tag.itemId, role: "tested" });
      if (kind) {
        obsRows.push({
          itemId: tag.itemId,
          source: "practice",
          kind,
          correct: a.correct,
          // done_on dates this attempt's evidence; the session keeps its own taken_at.
          occurredAt: a.occurredAt,
          meta: { sessionId, questionId: row.id, surface: input.surface, mode },
        });
      }
    }
  }

  if (itemRows.length > 0) await db.insert(questionItems).values(itemRows);
  if (obsRows.length > 0) await db.insert(observations).values(obsRows);
  const vq =
    gapEntries.length > 0
      ? await queueVocab(gapEntries, { at: input.takenAt, surface: input.surface, sessionId, label: input.label }, index)
      : null;

  return {
    sessionId,
    mode,
    questions: attempts.length,
    graded,
    correct,
    observations: obsRows.length,
    vocabQueued: vq ? vq.queued + vq.bumped : 0,
    unresolvedTags: unresolvedWithSuggestions(index, unresolved),
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
  /** Why it matched the topic (see InsightMatch); absent when no topic was given. */
  matched?: InsightMatch;
}

/** Case-insensitive "this jsonb tag array holds this tag". */
function hasTag(tag: string) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${insights.tags}) AS t WHERE lower(t) = ${tag.toLowerCase()})`;
}

/**
 * `topic` matches a library item the insight is linked to (see topicItemIds: the same form,
 * or a grammar pattern built on it, はず -> 〜はずだ), an exact tag (case-insensitive), or the
 * text (substring). Item and tag matches rank first, then text-only matches, newest first
 * within each; each result says which in `matched`. `tags` keeps only insights carrying all
 * of the given tags. Without a topic, newest first. The SQL narrows the candidates;
 * rankInsights decides.
 */
export async function getInsights(opts: { topic?: string; tags?: string[]; limit?: number } = {}): Promise<InsightSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const topic = opts.topic?.trim();
  const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const db = getDb();
  const index = await loadItemIndex();
  const topicItems = topic ? topicItemIds(index, topic) : [];
  const conds = tags.map(hasTag);
  if (topic) {
    const linked = topicItems.map((id) => sql` OR ${insights.itemIds} @> ${JSON.stringify([id])}::jsonb`);
    conds.push(sql`(${insights.text} ILIKE ${"%" + topic + "%"} OR ${hasTag(topic)}${sql.join(linked, sql``)})`);
  }
  const rows = await db
    .select()
    .from(insights)
    .where(conds.length > 0 ? sql`${sql.join(conds, sql` AND `)}` : undefined)
    .orderBy(desc(insights.createdAt))
    // Without a topic the order is plain recency, so the limit can go to SQL; with one, every
    // candidate is ranked first (a text hit must not crowd out an older item hit).
    .limit(topic ? 1000 : limit);
  return rankInsights(rows, { topic, topicItemIds: topicItems, tags, limit }).map(({ row: r, matched }) => ({
    id: r.id,
    text: r.text,
    tags: r.tags,
    items: r.itemIds.map((id) => index.byId.get(id)?.headword ?? id),
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    ...(matched ? { matched } : {}),
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

type LinkedQuestionRow = Record<string, unknown> & {
  question_id: string;
  item_id: string;
  is_correct: boolean | null;
  number: number;
  meta: Record<string, unknown> | null;
};

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
  // Evidence is planned before anything is written: a stored done_on that is not a date
  // fails here, leaving the session untouched instead of half-updated.
  const scope: EvidenceScope | null =
    changed.includes("mode") || changed.includes("taken_at")
      ? {
          sessionId: current.id,
          surface: current.surface,
          mode: patch.mode ?? current.mode,
          occurredAt: patch.takenAt ?? current.takenAt,
          confirmed: current.status === "confirmed",
        }
      : null;
  const planned = scope ? await planPracticeEvidence(scope) : null;

  if (changed.length > 0) await db.update(practiceSessions).set(patch).where(eq(practiceSessions.id, current.id));

  const obs: UpdateSessionResult["observations"] = scope && planned ? await writePracticeEvidence(scope, planned) : null;

  const session = (await listSessions(1, current.id))[0];
  return { session, changed, observations: obs };
}

// ---- Corrections: one attempt, one insight (update_attempt, update_insight, delete_insight).
// Same rule as update_session: a logged row is fixed in place, never re-logged.

interface EvidenceScope {
  sessionId: string;
  surface: PracticeSurface;
  mode: SessionMode;
  occurredAt: Date;
  /** Evidence exists only for confirmed sessions; one still in review gets its old rows removed and none written. */
  confirmed: boolean;
  /** Limit the rebuild to one question; omitted = the whole session. */
  questionId?: string;
}

/**
 * Delete and rewrite the practice observations of a session (or one of its questions) from
 * its question_items links. The single mechanism behind update_session (mode / taken_at)
 * and update_attempt (tags / correct / done_on), so both leave the evidence exactly as it
 * would have been written had the corrected values been logged in the first place: each
 * link dated by its question's done_on when set, else the session's taken_at.
 */
async function rebuildPracticeEvidence(scope: EvidenceScope): Promise<{ removed: number; written: number }> {
  return writePracticeEvidence(scope, await planPracticeEvidence(scope));
}

/** Read the links and build the rows (throws on a stored done_on that is not a date); writes nothing. */
async function planPracticeEvidence(scope: EvidenceScope): Promise<EvidenceRow[]> {
  if (!scope.confirmed) return [];
  const oneQuestion = scope.questionId;
  const links = await getDb().execute<LinkedQuestionRow>(sql`
    SELECT qi.question_id, qi.item_id, q.is_correct, q.number, q.meta
    FROM question_items qi
    JOIN practice_questions q ON q.id = qi.question_id
    WHERE q.session_id = ${scope.sessionId} AND qi.role = 'tested'
      ${oneQuestion ? sql`AND q.id = ${oneQuestion}` : sql``}
  `);
  return buildEvidenceRows(
    links.rows.map((l) => ({ questionId: l.question_id, itemId: l.item_id, isCorrect: l.is_correct, number: l.number, meta: l.meta })),
    { sessionId: scope.sessionId, surface: scope.surface, mode: scope.mode, occurredAt: scope.occurredAt },
  );
}

/** Replace the scope's practice observations with the planned rows. */
async function writePracticeEvidence(scope: EvidenceScope, rows: EvidenceRow[]): Promise<{ removed: number; written: number }> {
  const db = getDb();
  const oneQuestion = scope.questionId;
  const removed = await db.execute(sql`
    DELETE FROM observations
    WHERE source = 'practice' AND meta->>'sessionId' = ${scope.sessionId}
      ${oneQuestion ? sql`AND meta->>'questionId' = ${oneQuestion}` : sql``}
    RETURNING id
  `);
  if (rows.length > 0) await db.insert(observations).values(rows);
  return { removed: removed.rows.length, written: rows.length };
}

interface LocatedAttempt {
  session: PracticeSessionRow;
  question: PracticeQuestionRow;
  /** 1-based order of the attempt in its session. */
  position: number;
  /** Every attempt of the session in logged order (for clash checks when renumbering). */
  ordered: PracticeQuestionRow[];
}

/**
 * Find one attempt by session id and printed number (+ part for a multi-blank question,
 * + position when that still repeats). "Logged order" is insertion order: created_at, then
 * number, then id as tie-breaks.
 */
async function locateAttempt(sessionId: string, number: number, sel: AttemptSelector = {}): Promise<LocatedAttempt> {
  const db = getDb();
  const [session] = await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId));
  if (!session) throw new Error(`No session with id ${sessionId}. Use list_sessions to find it.`);
  const questions = await db
    .select()
    .from(practiceQuestions)
    .where(eq(practiceQuestions.sessionId, sessionId))
    .orderBy(asc(practiceQuestions.createdAt), asc(practiceQuestions.number), asc(practiceQuestions.id));
  try {
    const picked = pickAttempt(questions, number, sel);
    return { session, question: picked.row, position: picked.position, ordered: questions };
  } catch (e) {
    throw new Error(`Session "${session.label}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Vocab-queue entries for words that stalled on one attempt: tied to the question, context defaulting to its note or stem. */
function attemptGapEntries(gaps: VocabGapInput[], questionId: string, attempt: { note: string | null; stem: string }): VocabGapEntry[] {
  return gaps.map((g) => ({ ...g, context: g.context ?? attempt.note ?? (attempt.stem || null), questionId }));
}

/** The sighting context log_attempts gives an attempt's vocab_gaps: the session's date, surface, id and label. */
function sessionSighting(session: PracticeSessionRow): QueueContext {
  return { at: session.takenAt, surface: session.surface, sessionId: session.id, label: session.label };
}

export interface UpdateAttemptInput {
  sessionId: string;
  /** Printed number of the attempt to correct. */
  number: number;
  /** Part (blank) of the attempt to correct, for a multi-blank question. */
  part?: number;
  /** 1-based order in the session; needed only when number (+ part) still matches several attempts. */
  position?: number;
  /** Renumber the attempt (e.g. undoing a shifted-number workaround). */
  newNumber?: number;
  /** Set the attempt's part; null clears it. */
  newPart?: number | null;
  /** Already validated (parseDoneOn); null clears. Rebuilds the attempt's evidence. */
  doneOn?: string | null;
  /** Already normalised (normalizeSlips); replaces the list, empty clears. */
  slips?: Slip[];
  /** Replaces the tag list (re-resolved; evidence rebuilt). */
  tags?: ExtractedTag[];
  correct?: boolean | null;
  /** Already normalised; null clears. */
  rootCause?: string | null;
  note?: string | null;
  stem?: string | null;
  explanation?: string | null;
  /** Shallow merge; a key set to null is removed. */
  meta?: Record<string, unknown>;
  /** Added to the vocab queue linked to this attempt; existing queue rows are never removed. */
  vocabGaps?: VocabGapInput[];
}

export interface AttemptView {
  questionId: string;
  position: number;
  number: number;
  /** Blank of a multi-blank question, or null. */
  part: number | null;
  /** The day this attempt was done when it differs from the session's taken_at (YYYY-MM-DD), or null. */
  doneOn: string | null;
  /** Non-pattern errors noted on the answer; never evidence. */
  slips: Slip[];
  section: PracticeSection;
  correct: boolean | null;
  rootCause: string | null;
  note: string | null;
  stem: string | null;
  explanation: string | null;
  tags: QuestionTag[];
  meta: Record<string, unknown> | null;
}

export interface UpdateAttemptResult {
  sessionId: string;
  mode: SessionMode;
  /** The attempt as it now stands. */
  attempt: AttemptView;
  /** Fields whose value actually changed (tags, correct, root_cause, note, stem, explanation, number, part, done_on, slips, meta). */
  changed: string[];
  /** Evidence rows rewritten for this attempt when tags, correct or done_on changed; null otherwise. */
  observations: { removed: number; written: number } | null;
  /** The attempt's tags that still match no library item, grouped as in log_attempts. */
  unresolvedTags: UnresolvedTag[];
  /** Vocab-queue rows created or bumped from vocab_gaps. */
  vocabQueued: number;
}

/**
 * Correct one logged attempt in place. Tags are replaced and re-resolved, and a change to
 * tags or correct rebuilds that attempt's question_items and observations under the
 * session's mode, so every report stays consistent with the corrected row.
 */
export async function updateAttempt(input: UpdateAttemptInput): Promise<UpdateAttemptResult> {
  const db = getDb();
  const { session, question, position, ordered } = await locateAttempt(input.sessionId, input.number, {
    part: input.part,
    position: input.position,
  });

  let index: ItemIndex | null = null;
  const getIndex = async (): Promise<ItemIndex> => (index ??= await loadItemIndex());

  const tags = input.tags !== undefined ? await resolveTags(input.tags, await getIndex()) : undefined;
  const plan = planAttemptPatch(
    {
      number: question.number,
      isCorrect: question.isCorrect,
      rootCause: question.rootCause,
      note: question.note,
      stem: question.stem,
      explanation: question.explanation,
      meta: question.meta,
      tags: question.tags,
    },
    {
      tags,
      correct: input.correct,
      rootCause: input.rootCause,
      note: input.note,
      stem: input.stem,
      explanation: input.explanation,
      meta: input.meta,
      number: input.newNumber,
      part: input.newPart,
      doneOn: input.doneOn,
      slips: input.slips,
    },
  );
  const { next } = plan;

  // Checks that need no write, done before any write so a refusal leaves the row as it was.
  if (plan.changed.includes("number") || plan.changed.includes("part")) {
    const part = readPart(next.meta);
    const other =
      part === null ? undefined : ordered.find((q) => q.id !== question.id && q.number === next.number && readPart(q.meta) === part);
    if (other) {
      throw new Error(
        `Session "${session.label}": ${attemptName(next.number, readPart(next.meta))} already exists (${describeAttempt(other, ordered.indexOf(other) + 1)}). Give this attempt a different part, or fix the other one first.`,
      );
    }
  }
  // A stale rebuild dates by this row's done_on; refuse an unusable stored one now, not after the row is written.
  if (plan.evidenceStale) evidenceDate(next.meta, session.takenAt, `Attempt ${attemptName(next.number, readPart(next.meta))}`);

  if (plan.changed.length > 0) {
    await db
      .update(practiceQuestions)
      .set({
        number: next.number,
        isCorrect: next.isCorrect,
        rootCause: next.rootCause,
        note: next.note,
        stem: next.stem,
        explanation: next.explanation,
        meta: next.meta,
        tags: next.tags,
      })
      .where(eq(practiceQuestions.id, question.id));
  }

  if (plan.changed.includes("tags")) {
    await db.delete(questionItems).where(and(eq(questionItems.questionId, question.id), eq(questionItems.role, "tested")));
    const itemIds = linkedItemIds(next.tags);
    if (itemIds.length > 0) {
      await db
        .insert(questionItems)
        .values(itemIds.map((itemId) => ({ questionId: question.id, itemId, role: "tested" as const })))
        .onConflictDoNothing();
    }
  }

  // done_on is per attempt, so the session's taken_at here is only the fallback date.
  const obs = plan.evidenceStale
    ? await rebuildPracticeEvidence({
        sessionId: session.id,
        surface: session.surface,
        mode: session.mode,
        occurredAt: session.takenAt,
        confirmed: session.status === "confirmed",
        questionId: question.id,
      })
    : null;

  let vocabQueued = 0;
  if (input.vocabGaps && input.vocabGaps.length > 0) {
    const vq = await queueVocab(attemptGapEntries(input.vocabGaps, question.id, next), sessionSighting(session), await getIndex());
    vocabQueued = vq.queued + vq.bumped;
  }

  const occurrences = unresolvedOccurrences([{ number: next.number, tags: next.tags }]);
  const unresolvedTags = occurrences.length > 0 ? unresolvedWithSuggestions(await getIndex(), occurrences) : [];
  const doneOn = readDoneOn(next.meta);

  return {
    sessionId: session.id,
    mode: session.mode,
    attempt: {
      questionId: question.id,
      position,
      number: next.number,
      part: readPart(next.meta),
      doneOn: doneOn.kind === "date" ? doneOn.iso : null,
      slips: readSlips(next.meta),
      section: question.section,
      correct: next.isCorrect,
      rootCause: next.rootCause,
      note: next.note,
      stem: next.stem || null,
      explanation: next.explanation,
      tags: next.tags,
      meta: next.meta,
    },
    changed: plan.changed,
    observations: obs,
    unresolvedTags,
    vocabQueued,
  };
}

export interface QueueVocabForAttemptInput {
  sessionId: string;
  number: number;
  /** Part (blank) of a multi-blank question. */
  part?: number;
  position?: number;
  words: VocabGapInput[];
  /** Defaults to the session's taken_at, as for an attempt's vocab_gaps. */
  at?: Date;
  /** Defaults to the session's label. */
  label?: string | null;
}

export interface QueueVocabForAttemptResult extends QueueVocabResult {
  attempt: { sessionId: string; questionId: string; number: number; part: number | null; position: number };
}

/**
 * queue_vocab with a session link: words noticed after the set was logged, tied to their
 * question with the same sighting an attempt-level vocab_gap gets.
 */
export async function queueVocabForAttempt(input: QueueVocabForAttemptInput): Promise<QueueVocabForAttemptResult> {
  const { session, question, position } = await locateAttempt(input.sessionId, input.number, {
    part: input.part,
    position: input.position,
  });
  const ctx = sessionSighting(session);
  const result = await queueVocab(attemptGapEntries(input.words, question.id, question), {
    ...ctx,
    at: input.at ?? ctx.at,
    label: input.label?.trim() || ctx.label,
  });
  return {
    ...result,
    attempt: { sessionId: session.id, questionId: question.id, number: question.number, part: readPart(question.meta), position },
  };
}

export interface UpdateInsightInput {
  id: string;
  text?: string;
  /** Replaces the topic tags. */
  tags?: string[];
  /** Replaces the item references; re-resolved, unmatched ones kept for relink_tags. */
  items?: ExtractedTag[];
}

export interface UpdateInsightResult {
  id: string;
  text: string;
  tags: string[];
  items: QuestionTag[];
  /** Fields whose value actually changed (text, tags, items). */
  changed: string[];
  linkedItems: number;
  /** Kept on the insight; `relink_tags` attaches them once the library has a match. */
  unresolvedItems: UnresolvedItem[];
}

const sameQuestionTags = (a: QuestionTag[], b: QuestionTag[]) =>
  a.length === b.length && a.every((t, i) => t.kind === b[i].kind && t.text === b[i].text && t.itemId === b[i].itemId);

/** Correct an insight's text, tags or items in place (replace semantics for the lists). */
export async function updateInsight(input: UpdateInsightInput): Promise<UpdateInsightResult> {
  const db = getDb();
  const [current] = await db.select().from(insights).where(eq(insights.id, input.id));
  if (!current) throw new Error(`No insight with id ${input.id}. get_insights lists ids.`);

  const patch: Partial<typeof insights.$inferInsert> = {};
  const changed: string[] = [];
  let index: ItemIndex | null = null;

  if (input.text !== undefined) {
    const text = input.text.trim();
    if (!text) throw new Error("Insight text is empty.");
    if (text !== current.text) {
      patch.text = text;
      changed.push("text");
    }
  }
  if (input.tags !== undefined) {
    const tags = input.tags.map((t) => t.trim()).filter(Boolean);
    if (JSON.stringify(tags) !== JSON.stringify(current.tags)) {
      patch.tags = tags;
      changed.push("tags");
    }
  }
  if (input.items !== undefined) {
    index = await loadItemIndex();
    const resolved = await resolveTags(input.items, index);
    if (!sameQuestionTags(resolved, current.items)) {
      patch.items = resolved;
      patch.itemIds = linkedItemIds(resolved);
      changed.push("items");
    }
  }
  if (changed.length > 0) await db.update(insights).set(patch).where(eq(insights.id, current.id));

  const items = patch.items ?? current.items;
  const itemIds = patch.itemIds ?? current.itemIds;
  const unresolved = items.filter((t) => !t.itemId);
  const idx = unresolved.length > 0 ? (index ?? (await loadItemIndex())) : null;
  return {
    id: current.id,
    text: patch.text ?? current.text,
    tags: patch.tags ?? current.tags,
    items,
    changed,
    linkedItems: itemIds.length,
    unresolvedItems: idx
      ? unresolved.map(({ kind, text }) => ({ kind, text, suggestions: suggestItems(idx, text, { kind, limit: 3 }) }))
      : [],
  };
}

export interface DeleteInsightResult {
  /** What was removed, so it can be shown back (and re-logged if the delete was a mistake). */
  deleted: { id: string; text: string; tags: string[]; items: string[]; createdAt: string };
}

/**
 * Remove an insight. Its item links live on the row (items / item_ids), so nothing else
 * references it, and insights write no observations.
 */
export async function deleteInsight(id: string): Promise<DeleteInsightResult> {
  const [row] = await getDb().delete(insights).where(eq(insights.id, id)).returning();
  if (!row) throw new Error(`No insight with id ${id}. get_insights lists ids.`);
  return {
    deleted: {
      id: row.id,
      text: row.text,
      tags: row.tags,
      items: row.items.map((t) => t.text),
      createdAt: row.createdAt.toISOString(),
    },
  };
}

export interface RelinkResult {
  questionsChecked: number;
  tagsRelinked: number;
  observations: number;
  insightsChecked: number;
  insightItemsRelinked: number;
  /** Distinct tag texts that still match nothing, with how often they occur. */
  stillUnresolved: { kind: ExtractedTag["kind"]; text: string; n: number; suggestions: ItemSuggestion[] }[];
  /** Vocab-queue rows with no library item that got one this run. */
  queueLinked: number;
  /** Texts of the vocab-queue rows still without a library item. */
  queueUnlinked: string[];
  /**
   * Attempts skipped because their stored meta.done_on is not a date (a hand edit): their
   * evidence date is unknown, so nothing is linked until update_attempt fixes done_on.
   * Present only when non-empty.
   */
  invalidDoneOn?: { sessionId: string; questionId: string; number: number; doneOn: unknown }[];
}

type UnresolvedQuestionRow = Record<string, unknown> & {
  id: string;
  session_id: string;
  number: number;
  is_correct: boolean | null;
  tags: QuestionTag[];
  meta: Record<string, unknown> | null;
  mode: SessionMode;
  surface: PracticeSurface;
  taken_at: string | Date;
};

/**
 * Re-run resolution over every stored tag that has no item yet (questions and insights)
 * and attach the evidence that was skipped at log time. Idempotent: only tags whose
 * itemId is still null are touched, so running it twice writes nothing the second time.
 * This is what makes "capture first, classify later" true for item links: seed the
 * missing item or add an alias, then relink. Vocab-queue rows with no item are linked the
 * same way (relinkVocabQueue), filling only nulls.
 */
export async function relinkUnresolved(): Promise<RelinkResult> {
  const db = getDb();
  const index = await loadItemIndex();

  const qRes = await db.execute<UnresolvedQuestionRow>(sql`
    SELECT q.id, q.session_id, q.number, q.is_correct, q.tags, q.meta, s.mode, s.surface, s.taken_at
    FROM practice_questions q
    JOIN practice_sessions s ON s.id = q.session_id
    WHERE s.status = 'confirmed'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.tags) t WHERE t->>'itemId' IS NULL)
  `);

  const itemRows: { questionId: string; itemId: string; role: "tested" }[] = [];
  const obsRows: (typeof observations.$inferInsert)[] = [];
  const still = new Map<string, { kind: ExtractedTag["kind"]; text: string; n: number }>();
  const invalidDoneOn: NonNullable<RelinkResult["invalidDoneOn"]> = [];
  let tagsRelinked = 0;

  for (const q of qRes.rows) {
    // Evidence written here is dated like log_attempts dates it: the attempt's done_on, else the session.
    const stored = readDoneOn(q.meta);
    if (stored.kind === "invalid") {
      invalidDoneOn.push({ sessionId: q.session_id, questionId: q.id, number: q.number, doneOn: stored.raw });
      continue;
    }
    const occurredAt = stored.kind === "date" ? stored.at : new Date(q.taken_at);
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
          occurredAt,
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

  const queue = await relinkVocabQueue(index);

  return {
    questionsChecked: qRes.rows.length,
    tagsRelinked,
    observations: obsRows.length,
    insightsChecked: iRes.rows.length,
    insightItemsRelinked,
    stillUnresolved: [...still.values()]
      .sort((a, b) => b.n - a.n)
      .map((u) => ({ ...u, suggestions: suggestItems(index, u.text, { kind: u.kind, limit: 3 }) })),
    queueLinked: queue.linked,
    queueUnlinked: queue.unlinked,
    ...(invalidDoneOn.length > 0 ? { invalidDoneOn } : {}),
  };
}
