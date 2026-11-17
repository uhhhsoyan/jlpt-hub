import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { vocabQueue, type VocabQueueRow } from "@/lib/db/schema";
import { matchTag, type ItemIndex } from "@/lib/item-match";
import { loadItemIndex } from "@/lib/resolve-items";
import { VOCAB_QUEUE_STATUSES, type PracticeSurface, type VocabQueueStatus, type VocabSighting } from "@/lib/types";
import {
  decideQueueLink,
  effectiveAsMet,
  matchQueueItem,
  mergeSightings,
  normalizeQueueText,
  sightingAsMet,
  statusOnResight,
  type QueueLookup,
} from "@/lib/vocab-queue-core";

export {
  effectiveAsMet,
  exportFilename,
  mergeSightings,
  normalizeQueueText,
  statusOnResight,
  toAnkiTsv,
  type AnkiRow,
} from "@/lib/vocab-queue-core";

/**
 * The vocab queue: every word the learner says they did not know, captured where it happens
 * (a `vocab_gaps` entry on a logged attempt, the `queue_vocab` tool, the Hub) and reviewed by
 * hand at /queue, where rows are exported to Anki and marked carded / skipped / known.
 *
 * One row per word (NFKC-normalised); a repeat bumps `seenCount`, appends a sighting and
 * fills in reading/meaning the first sighting lacked. A word marked skipped or known that
 * stalls again goes back to queued; carded stays carded (the card exists).
 */

export interface VocabGapInput {
  /** The kanji / dictionary form, used for linking to the library; dictionary form for verbs/adjectives. */
  text: string;
  reading?: string | null;
  /** Short English gloss. */
  meaning?: string | null;
  /** The phrase or sentence it stalled in. */
  context?: string | null;
  /** The form exactly as printed when it differs from text (おおぜい for 大勢); kept on the sighting. */
  asMet?: string | null;
}

export interface VocabGapEntry extends VocabGapInput {
  questionId?: string | null;
}

export interface QueueContext {
  at: Date;
  surface: PracticeSurface;
  sessionId?: string | null;
  label?: string | null;
}

export interface QueuedWord {
  id: string;
  text: string;
  status: VocabQueueStatus;
  seenCount: number;
  itemId: string | null;
  /** The row's effective as-met form (most recent sighting that has one), or null. */
  asMet: string | null;
  /** true when this call created the row, false when it bumped an existing one. */
  created: boolean;
}

/** The queue's matcher over the item index: matchTag on the vocab kind, with the hit's headword. */
function queueLookup(idx: ItemIndex): QueueLookup {
  return (text) => {
    const id = matchTag(idx, { kind: "vocab", text });
    const row = id ? idx.byId.get(id) : undefined;
    return id && row ? { id, headword: row.headword } : null;
  };
}

export interface QueueVocabResult {
  queued: number;
  bumped: number;
  words: QueuedWord[];
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/** Add words to the queue (or bump them). Sequential: a few words per call, never bulk. */
export async function queueVocab(entries: VocabGapEntry[], ctx: QueueContext, index?: ItemIndex): Promise<QueueVocabResult> {
  const db = getDb();
  const idx = index ?? (await loadItemIndex());
  const result: QueueVocabResult = { queued: 0, bumped: 0, words: [] };
  const seen = new Set<string>();

  for (const e of entries) {
    const text = e.text.normalize("NFKC").trim();
    const norm = normalizeQueueText(text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    const itemId = matchQueueItem(text, clean(e.reading), queueLookup(idx))?.itemId ?? null;
    const item = itemId ? idx.byId.get(itemId) : undefined;
    const reading = clean(e.reading) ?? item?.reading ?? null;
    const meaning = clean(e.meaning) ?? item?.meaning ?? null;
    const asMet = sightingAsMet(e.asMet, text);
    const sighting: VocabSighting = {
      at: ctx.at.toISOString(),
      context: clean(e.context),
      sessionId: ctx.sessionId ?? null,
      questionId: e.questionId ?? null,
      label: clean(ctx.label),
      ...(asMet ? { asMet } : {}),
    };

    const [existing] = await db.select().from(vocabQueue).where(eq(vocabQueue.norm, norm)).limit(1);
    if (existing) {
      const sightings = mergeSightings(existing.sightings, sighting);
      const bumped = sightings.length !== existing.sightings.length;
      const status = bumped ? statusOnResight(existing.status) : existing.status;
      const [row] = await db
        .update(vocabQueue)
        .set({
          reading: existing.reading ?? reading,
          meaning: existing.meaning ?? meaning,
          itemId: existing.itemId ?? itemId,
          status,
          seenCount: bumped ? existing.seenCount + 1 : existing.seenCount,
          lastSeenAt: ctx.at > existing.lastSeenAt ? ctx.at : existing.lastSeenAt,
          firstSeenAt: ctx.at < existing.firstSeenAt ? ctx.at : existing.firstSeenAt,
          sightings,
          updatedAt: new Date(),
        })
        .where(eq(vocabQueue.id, existing.id))
        .returning();
      if (bumped) result.bumped += 1;
      result.words.push({ ...wordView(row), created: false });
      continue;
    }

    const [row] = await db
      .insert(vocabQueue)
      .values({
        norm,
        text,
        reading,
        meaning,
        itemId,
        status: "queued",
        seenCount: 1,
        firstSeenAt: ctx.at,
        lastSeenAt: ctx.at,
        sightings: [sighting],
        surface: ctx.surface,
      })
      .returning();
    result.queued += 1;
    result.words.push({ ...wordView(row), created: true });
  }
  return result;
}

function wordView(row: VocabQueueRow): Omit<QueuedWord, "created"> {
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    seenCount: row.seenCount,
    itemId: row.itemId,
    asMet: effectiveAsMet(row.sightings),
  };
}

export interface QueueRelinkResult {
  /** Rows with no library link that were checked. */
  checked: number;
  /** Rows that got a link this run. */
  linked: number;
  /** Texts of the rows still without a link. */
  unlinked: string[];
}

/**
 * Link queue rows whose item_id is null to a library item added since they were queued,
 * with the same matching insert uses (matchQueueItem). Only nulls are filled: the update is
 * guarded on item_id IS NULL, and reading/meaning are filled from the item only where the
 * row has none, as at insert. Part of relink_tags (lib/ledger.ts relinkUnresolved).
 */
export async function relinkVocabQueue(index?: ItemIndex): Promise<QueueRelinkResult> {
  const db = getDb();
  const idx = index ?? (await loadItemIndex());
  const lookup = queueLookup(idx);
  const rows = await db.select().from(vocabQueue).where(isNull(vocabQueue.itemId)).orderBy(asc(vocabQueue.firstSeenAt));
  const unlinked: string[] = [];
  let linked = 0;
  for (const row of rows) {
    const match = decideQueueLink(row, lookup);
    if (!match) {
      unlinked.push(row.text);
      continue;
    }
    const item = idx.byId.get(match.itemId);
    const updated = await db
      .update(vocabQueue)
      .set({
        itemId: match.itemId,
        reading: row.reading ?? item?.reading ?? null,
        meaning: row.meaning ?? item?.meaning ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(vocabQueue.id, row.id), isNull(vocabQueue.itemId)))
      .returning({ id: vocabQueue.id });
    if (updated.length > 0) linked += 1;
  }
  return { checked: rows.length, linked, unlinked };
}

export type QueueFilter = VocabQueueStatus | "all";

export async function listVocabQueue(opts: { status?: QueueFilter; limit?: number } = {}): Promise<VocabQueueRow[]> {
  const status = opts.status ?? "queued";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const q = getDb().select().from(vocabQueue);
  const rows = status === "all" ? await q.orderBy(asc(vocabQueue.status), desc(vocabQueue.lastSeenAt)).limit(limit) : await q.where(eq(vocabQueue.status, status)).orderBy(desc(vocabQueue.lastSeenAt)).limit(limit);
  return rows;
}

export type QueueCounts = Record<VocabQueueStatus, number>;

export async function countVocabQueue(): Promise<QueueCounts> {
  const rows = await getDb()
    .select({ status: vocabQueue.status, n: sql<number>`count(*)::int` })
    .from(vocabQueue)
    .groupBy(vocabQueue.status);
  const out = Object.fromEntries(VOCAB_QUEUE_STATUSES.map((s) => [s, 0])) as QueueCounts;
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/** Returns how many rows changed. */
export async function setVocabQueueStatus(ids: string[], status: VocabQueueStatus): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await getDb()
    .update(vocabQueue)
    .set({ status, updatedAt: new Date() })
    .where(inArray(vocabQueue.id, ids))
    .returning({ id: vocabQueue.id });
  return rows.length;
}

/** Every row in one status to another (used by "mark all queued as carded" after an export). */
export async function moveVocabQueueStatus(from: VocabQueueStatus, to: VocabQueueStatus): Promise<number> {
  const rows = await getDb()
    .update(vocabQueue)
    .set({ status: to, updatedAt: new Date() })
    .where(eq(vocabQueue.status, from))
    .returning({ id: vocabQueue.id });
  return rows.length;
}
