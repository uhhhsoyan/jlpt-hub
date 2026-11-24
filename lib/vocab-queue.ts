import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { vocabQueue, type VocabQueueRow } from "@/lib/db/schema";
import { matchTag, type ItemIndex } from "@/lib/item-match";
import { loadItemIndex } from "@/lib/resolve-items";
import { VOCAB_QUEUE_STATUSES, type PracticeSurface, type VocabQueueStatus, type VocabSighting } from "@/lib/types";
import {
  decideQueueLink,
  effectiveAsMet,
  emptyQueueResult,
  matchQueueItem,
  normalizeQueueText,
  planQueueEdit,
  planResight,
  recordQueuedWord,
  sightingAsMet,
  type QueuedWord,
  type QueueEdit,
  type QueueEditPlan,
  type QueueLookup,
  type QueueVocabResult,
} from "@/lib/vocab-queue-core";

export {
  attemptVocabResult,
  effectiveAsMet,
  exportFilename,
  mergeQueueResults,
  mergeSightings,
  normalizeQueueText,
  planQueueTargets,
  statusOnResight,
  toAnkiTsv,
  validateQueueUpdate,
  type AnkiRow,
  type AttemptVocabResult,
  type QueuedWord,
  type QueueEdit,
  type QueueVocabResult,
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

/** The queue's matcher over the item index: matchTag on the vocab kind, with the hit's headword. */
function queueLookup(idx: ItemIndex): QueueLookup {
  return (text) => {
    const id = matchTag(idx, { kind: "vocab", text });
    const row = id ? idx.byId.get(id) : undefined;
    return id && row ? { id, headword: row.headword } : null;
  };
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/** Add words to the queue (or bump them). Sequential: a few words per call, never bulk. */
export async function queueVocab(entries: VocabGapEntry[], ctx: QueueContext, index?: ItemIndex): Promise<QueueVocabResult> {
  const db = getDb();
  const idx = index ?? (await loadItemIndex());
  const result = emptyQueueResult();
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
      const next = planResight(existing, sighting);
      const [row] = await db
        .update(vocabQueue)
        .set({
          reading: existing.reading ?? reading,
          meaning: existing.meaning ?? meaning,
          itemId: existing.itemId ?? itemId,
          status: next.status,
          seenCount: next.seenCount,
          lastSeenAt: ctx.at > existing.lastSeenAt ? ctx.at : existing.lastSeenAt,
          firstSeenAt: ctx.at < existing.firstSeenAt ? ctx.at : existing.firstSeenAt,
          sightings: next.sightings,
          updatedAt: new Date(),
        })
        .where(eq(vocabQueue.id, existing.id))
        .returning();
      recordQueuedWord(result, wordView(row), next.bumped ? "bumped" : "unchanged");
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
    recordQueuedWord(result, wordView(row), "created");
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

export interface EditedQueueWord {
  id: string;
  text: string;
  reading: string | null;
  meaning: string | null;
  asMet: string | null;
  itemId: string | null;
  status: VocabQueueStatus;
  seenCount: number;
  /** Fields that actually changed: text, reading, meaning, as_met, item. */
  changed: QueueEditPlan["changed"];
}

/**
 * Per-row field edits (update_vocab_queue `edits`): as_met, reading, meaning, text. Never
 * adds a sighting or bumps seenCount (planQueueEdit in lib/vocab-queue-core.ts). Every row is
 * loaded and every edit planned before the first write, so a missing id, or a new text that
 * is already another row's word, fails the whole call with nothing changed.
 */
export async function editVocabQueueRows(edits: QueueEdit[], index?: ItemIndex): Promise<EditedQueueWord[]> {
  if (edits.length === 0) return [];
  const db = getDb();
  const ids = edits.map((e) => e.id);
  const rows = await db.select().from(vocabQueue).where(inArray(vocabQueue.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`No queue row with id ${missing.join(", ")}; ids come from get_vocab_queue.`);

  // The item index is only needed when a text changes (re-linking).
  const idx = edits.some((e) => e.text !== undefined) ? (index ?? (await loadItemIndex())) : null;
  const lookup: QueueLookup = idx ? queueLookup(idx) : () => null;
  const itemInfo = (itemId: string) => {
    const item = idx?.byId.get(itemId);
    return item ? { reading: item.reading || null, meaning: item.meaning || null } : undefined;
  };

  const plans: { row: VocabQueueRow; plan: QueueEditPlan }[] = [];
  for (const e of edits) {
    const row = byId.get(e.id);
    if (row) plans.push({ row, plan: planQueueEdit(row, e, lookup, itemInfo) });
  }

  // A new text changes the row's norm, which is unique: refuse a rename onto another row's word.
  const renamedTo = new Map<string, string>();
  for (const { row, plan } of plans) {
    const norm = plan.patch.norm;
    if (norm === undefined) continue;
    const other = renamedTo.get(norm);
    if (other) throw new Error(`Two edits rename rows to the same word (${plan.patch.text}): ${other} and ${row.id}.`);
    renamedTo.set(norm, row.id);
    const [taken] = await db
      .select({ id: vocabQueue.id, text: vocabQueue.text })
      .from(vocabQueue)
      .where(and(eq(vocabQueue.norm, norm), ne(vocabQueue.id, row.id)))
      .limit(1);
    if (taken) {
      throw new Error(
        `Cannot rename ${row.text} to ${plan.patch.text}: row ${taken.id} (${taken.text}) is already that word. ` +
          "Mark one of the two skipped instead.",
      );
    }
  }

  const out: EditedQueueWord[] = [];
  for (const { row, plan } of plans) {
    let next = row;
    if (Object.keys(plan.patch).length > 0) {
      [next] = await db
        .update(vocabQueue)
        .set({ ...plan.patch, updatedAt: new Date() })
        .where(eq(vocabQueue.id, row.id))
        .returning();
    }
    out.push({
      id: next.id,
      text: next.text,
      reading: next.reading,
      meaning: next.meaning,
      asMet: effectiveAsMet(next.sightings),
      itemId: next.itemId,
      status: next.status,
      seenCount: next.seenCount,
      changed: plan.changed,
    });
  }
  return out;
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
