import type { VocabQueueStatus, VocabSighting } from "./types";

/**
 * Pure helpers for the vocab queue (no DB, no path aliases) so they unit-test under plain
 * `node --test`; lib/vocab-queue.ts re-exports them next to the DB functions.
 */

export interface AnkiRow {
  text: string;
  reading: string | null;
  meaning: string | null;
  sightings: VocabSighting[];
  lastSeenAt: Date;
}

/** Identity key for a word: NFKC, trimmed, inner whitespace removed, lower-cased for romaji. */
export function normalizeQueueText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();
}

/**
 * Appends a sighting unless the same question (or the same moment and context) is already
 * recorded; newest last, capped. A repeat that brings an as_met the recorded sighting lacks
 * fills it in (same length, so it does not count as a bump).
 */
export function mergeSightings(existing: VocabSighting[], next: VocabSighting, max = 20): VocabSighting[] {
  const dupIndex = existing.findIndex((s) =>
    next.questionId ? s.questionId === next.questionId : s.at === next.at && s.context === next.context,
  );
  if (dupIndex >= 0) {
    if (!next.asMet || existing[dupIndex].asMet) return existing;
    return existing.map((s, i) => (i === dupIndex ? { ...s, asMet: next.asMet } : s));
  }
  const out = [...existing, next];
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * The as_met to store on a sighting: the printed form, NFKC-trimmed, or null when absent or
 * the same word as the row's text (nothing to show when 大勢 was printed as 大勢).
 */
export function sightingAsMet(asMet: string | null | undefined, text: string): string | null {
  const v = asMet?.normalize("NFKC").trim();
  if (!v) return null;
  return normalizeQueueText(v) === normalizeQueueText(text) ? null : v;
}

/** A row's effective as_met: the most recent sighting that has one, else null. */
export function effectiveAsMet(sightings: VocabSighting[]): string | null {
  for (let i = sightings.length - 1; i >= 0; i--) {
    const v = sightings[i].asMet?.trim();
    if (v) return v;
  }
  return null;
}

/** What the queue's matcher returns for a string: the item and its headword. */
export type QueueLookup = (text: string) => { id: string; headword: string } | null;

export interface QueueMatch {
  itemId: string;
  via: "text" | "reading";
}

/**
 * The queue's matching ladder, shared by insert and relink: the word's text (headword,
 * alias, kana reading, as matchTag does), then its stored reading. A reading hit counts only
 * when the library writes that word in kana (綺麗 queued, きれい in the library): a reading
 * that merely equals a kanji item's reading is a homophone (掃く and 履く are both はく), so
 * it is left unlinked rather than guessed.
 */
export function matchQueueItem(text: string, reading: string | null | undefined, lookup: QueueLookup): QueueMatch | null {
  const t = text.trim();
  const byText = t ? lookup(t) : null;
  if (byText) return { itemId: byText.id, via: "text" };
  const r = reading?.trim();
  const byReading = r ? lookup(r) : null;
  return byReading && normalizeQueueText(byReading.headword) === normalizeQueueText(r ?? "") ? { itemId: byReading.id, via: "reading" } : null;
}

/** Whether a queue row should be linked now: only rows with no link; an existing link is never changed. */
export function decideQueueLink(row: { itemId: string | null; text: string; reading: string | null }, lookup: QueueLookup): QueueMatch | null {
  if (row.itemId) return null;
  return matchQueueItem(row.text, row.reading, lookup);
}

// ---- Per-row edits (update_vocab_queue `edits`) -------------------------------------------

/** One row's edit. Absent fields are left alone; null clears as_met / reading / meaning. */
export interface QueueEdit {
  id: string;
  asMet?: string | null;
  reading?: string | null;
  meaning?: string | null;
  /** New kanji / dictionary form; re-runs item linking for the row. */
  text?: string;
}

export interface QueueUpdateInput {
  ids?: string[];
  status?: VocabQueueStatus;
  edits?: QueueEdit[];
}

/** Checks an update_vocab_queue call before any DB access. */
export function validateQueueUpdate({ ids, status, edits }: QueueUpdateInput): void {
  const hasIds = (ids?.length ?? 0) > 0;
  const hasEdits = (edits?.length ?? 0) > 0;
  if (status === undefined && hasIds) {
    throw new Error("ids were given without status; pass status to move those rows (per-row field changes go in edits).");
  }
  if (status === undefined && !hasEdits) {
    throw new Error("Nothing to change: pass ids with status, and/or edits [{id, as_met?, reading?, meaning?, text?}].");
  }
  if (status !== undefined && !hasIds) throw new Error(`status ${status} needs ids: the rows to move.`);
  const seen = new Set<string>();
  for (const [i, e] of (edits ?? []).entries()) {
    if (seen.has(e.id)) throw new Error(`edits[${i}]: id ${e.id} appears twice; put all changes to one row in one edit.`);
    seen.add(e.id);
    if (e.asMet === undefined && e.reading === undefined && e.meaning === undefined && e.text === undefined) {
      throw new Error(`edits[${i}] (${e.id}) changes nothing: pass as_met, reading, meaning and/or text.`);
    }
    if (e.text !== undefined && !normalizeQueueText(e.text)) throw new Error(`edits[${i}]: text is empty.`);
  }
}

function withoutAsMet(s: VocabSighting): VocabSighting {
  const out: VocabSighting = { ...s };
  delete out.asMet;
  return out;
}

/**
 * Sets a row's effective as_met without adding a sighting or touching seenCount. The value
 * is written onto the most recent sighting, which is what effectiveAsMet (and so the Anki
 * export and /queue) reads first; earlier sightings keep the form they were met in. Clearing
 * (null, blank, or the same word as `text`) removes as_met from every sighting, since an
 * earlier one would otherwise become the effective value again.
 */
export function setSightingsAsMet(sightings: VocabSighting[], asMet: string | null, text: string): VocabSighting[] {
  const v = sightingAsMet(asMet, text);
  if (v === null) {
    return sightings.map((s) => (s.asMet === undefined ? s : withoutAsMet(s)));
  }
  if (sightings.length === 0) throw new Error("This row has no sightings to carry as_met.");
  const last = sightings.length - 1;
  return sightings.map((s, i) => (i === last ? { ...s, asMet: v } : s));
}

export interface QueueEditRow {
  id: string;
  text: string;
  norm: string;
  reading: string | null;
  meaning: string | null;
  itemId: string | null;
  sightings: VocabSighting[];
}

export interface QueueEditPatch {
  text?: string;
  norm?: string;
  reading?: string | null;
  meaning?: string | null;
  itemId?: string | null;
  sightings?: VocabSighting[];
}

export interface QueueEditPlan {
  patch: QueueEditPatch;
  /** Fields that actually change: text, reading, meaning, as_met, item. */
  changed: ("text" | "reading" | "meaning" | "as_met" | "item")[];
}

/** Reading and meaning of a library item, to fill a row that has none (as at insert). */
export type QueueItemInfo = (itemId: string) => { reading: string | null; meaning: string | null } | undefined;

const cleanField = (s: string | null): string | null => {
  const t = s?.normalize("NFKC").trim();
  return t ? t : null;
};

/**
 * What one edit changes on a queue row. A new `text` re-runs the insert-time linking ladder
 * (matchQueueItem) and replaces the row's link, null when nothing matches, then fills reading
 * and meaning from the new item where the row has none and this edit did not clear them; an
 * as_met equal to the new text is dropped (nothing to show). `as_met` is set through
 * setSightingsAsMet. The norm changes with the text: the caller checks it is not taken.
 */
export function planQueueEdit(row: QueueEditRow, edit: QueueEdit, lookup: QueueLookup, itemInfo: QueueItemInfo): QueueEditPlan {
  const patch: QueueEditPatch = {};
  const changed: QueueEditPlan["changed"] = [];

  let reading = row.reading;
  let meaning = row.meaning;
  if (edit.reading !== undefined) reading = cleanField(edit.reading);
  if (edit.meaning !== undefined) meaning = cleanField(edit.meaning);

  let text = row.text;
  let itemId = row.itemId;
  let sightings = row.sightings;
  if (edit.text !== undefined) {
    text = edit.text.normalize("NFKC").trim();
    if (!normalizeQueueText(text)) throw new Error(`Edit for ${row.id}: text is empty.`);
    if (text !== row.text) {
      itemId = matchQueueItem(text, reading, lookup)?.itemId ?? null;
      const item = itemId ? itemInfo(itemId) : undefined;
      if (reading === null && edit.reading === undefined) reading = item?.reading ?? null;
      if (meaning === null && edit.meaning === undefined) meaning = item?.meaning ?? null;
      const norm = normalizeQueueText(text);
      sightings = sightings.map((s) => (s.asMet && normalizeQueueText(s.asMet) === norm ? withoutAsMet(s) : s));
    }
  }
  if (edit.asMet !== undefined) sightings = setSightingsAsMet(sightings, edit.asMet, text);

  if (text !== row.text) {
    patch.text = text;
    changed.push("text");
    const norm = normalizeQueueText(text);
    if (norm !== row.norm) patch.norm = norm;
  }
  if (reading !== row.reading) {
    patch.reading = reading;
    changed.push("reading");
  }
  if (meaning !== row.meaning) {
    patch.meaning = meaning;
    changed.push("meaning");
  }
  if (itemId !== row.itemId) {
    patch.itemId = itemId;
    changed.push("item");
  }
  if (JSON.stringify(sightings) !== JSON.stringify(row.sightings)) {
    patch.sightings = sightings;
    if (effectiveAsMet(sightings) !== effectiveAsMet(row.sightings)) changed.push("as_met");
  }
  return { patch, changed };
}

/** A word that stalls again is worth a card unless one already exists. */
export function statusOnResight(status: VocabQueueStatus): VocabQueueStatus {
  return status === "carded" ? "carded" : "queued";
}

// ---- Queue results (queue_vocab, and the vocab detail on log_attempts / update_attempt) ---

export interface QueuedWord {
  id: string;
  text: string;
  status: VocabQueueStatus;
  seenCount: number;
  itemId: string | null;
  /** The row's effective as-met form (most recent sighting that has one), or null. */
  asMet: string | null;
  /** true when this call created the row, false when it bumped (or re-saw) an existing one. */
  created: boolean;
}

export interface QueueVocabResult {
  /** Rows created. */
  queued: number;
  /** Existing rows that gained a sighting (seenCount + 1). */
  bumped: number;
  words: QueuedWord[];
}

/**
 * What a word does to its existing queue row: a sighting from a new question (or a new
 * moment) bumps seenCount and puts a skipped/known word back to queued; the same question
 * seen again changes neither (mergeSightings may still fill in a missing as_met).
 */
export function planResight(
  existing: { sightings: VocabSighting[]; seenCount: number; status: VocabQueueStatus },
  sighting: VocabSighting,
): { sightings: VocabSighting[]; bumped: boolean; seenCount: number; status: VocabQueueStatus } {
  const sightings = mergeSightings(existing.sightings, sighting);
  const bumped = sightings.length !== existing.sightings.length;
  return {
    sightings,
    bumped,
    seenCount: bumped ? existing.seenCount + 1 : existing.seenCount,
    status: bumped ? statusOnResight(existing.status) : existing.status,
  };
}

export const emptyQueueResult = (): QueueVocabResult => ({ queued: 0, bumped: 0, words: [] });

/** Add one word's outcome to a result: created counts as queued, a real bump as bumped, a re-seen row as neither. */
export function recordQueuedWord(result: QueueVocabResult, word: Omit<QueuedWord, "created">, outcome: "created" | "bumped" | "unchanged"): void {
  if (outcome === "created") result.queued += 1;
  if (outcome === "bumped") result.bumped += 1;
  result.words.push({ ...word, created: outcome === "created" });
}

/** Several queue calls (one per question) as one result, words in call order. */
export function mergeQueueResults(results: QueueVocabResult[]): QueueVocabResult {
  const out = emptyQueueResult();
  for (const r of results) {
    out.queued += r.queued;
    out.bumped += r.bumped;
    out.words.push(...r.words);
  }
  return out;
}

/** The vocab fields of a log_attempts / update_attempt result. */
export interface AttemptVocabResult {
  /** Rows created or bumped; kept for older callers (vocab.queued + vocab.bumped). */
  vocabQueued: number;
  /** The same detail queue_vocab returns; all zero and no words when the call had no vocab_gaps. */
  vocab: QueueVocabResult;
}

export function attemptVocabResult(vq: QueueVocabResult | null): AttemptVocabResult {
  const vocab = vq ?? emptyQueueResult();
  return { vocabQueued: vocab.queued + vocab.bumped, vocab };
}

// ---- queue_vocab tied to logged questions (one call, words for several questions) --------

/** The call-level question fields of queue_vocab. */
export interface QueueCallTarget {
  sessionId?: string;
  number?: number;
  part?: number;
  position?: number;
}

/** Words that go to one logged question. */
export interface QueueTargetGroup<W> {
  number: number;
  part?: number;
  position?: number;
  words: W[];
}

export type QueueTargetPlan<W> = { kind: "free"; words: W[] } | { kind: "attempts"; sessionId: string; groups: QueueTargetGroup<W>[] };

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Where each queue_vocab word goes. No session, number, part or position anywhere: free
 * words (reading, chat). Otherwise every word needs the session and a question number: its
 * own `number` when it has one (then its own `part`, and the call-level part and position do
 * not apply, since they name a different question), else the call's number, part and
 * position. Words are grouped per question in first-seen order. Throws before anything is
 * written, naming the word at fault.
 */
export function planQueueTargets<W extends { number?: number; part?: number }>(
  words: W[],
  call: QueueCallTarget,
): QueueTargetPlan<Omit<W, "number" | "part">> {
  const strip = (w: W): Omit<W, "number" | "part"> => {
    const rest: Record<string, unknown> = { ...w };
    delete rest.number;
    delete rest.part;
    return rest as Omit<W, "number" | "part">;
  };
  const perWord = words.some((w) => w.number !== undefined || w.part !== undefined);
  const callLevel = call.sessionId !== undefined || call.number !== undefined || call.part !== undefined || call.position !== undefined;
  if (!perWord && !callLevel) return { kind: "free", words: words.map(strip) };

  if (call.sessionId === undefined) {
    throw new Error(
      "To tie words to a logged question, pass session_id with number (on the call, or on each word for several questions); part for one blank of a multi-blank question, position only when that still repeats.",
    );
  }
  for (const [key, v] of [["number", call.number], ["part", call.part], ["position", call.position]] as const) {
    if (v !== undefined && !isPositiveInt(v)) throw new Error(`${key} must be a positive integer, got ${v}.`);
  }

  const groups = new Map<string, QueueTargetGroup<Omit<W, "number" | "part">>>();
  for (const [i, w] of words.entries()) {
    for (const [key, v] of [["number", w.number], ["part", w.part]] as const) {
      if (v !== undefined && !isPositiveInt(v)) throw new Error(`words[${i}].${key} must be a positive integer, got ${v}.`);
    }
    const own = w.number !== undefined;
    const number = own ? w.number : call.number;
    if (number === undefined) {
      throw new Error(`words[${i}] has no question number: pass number on the word, or on the call for every word without one.`);
    }
    const part = own ? w.part : (w.part ?? call.part);
    const position = own ? undefined : call.position;
    const key = `${number}:${part ?? ""}:${position ?? ""}`;
    const group = groups.get(key) ?? { number, ...(part !== undefined ? { part } : {}), ...(position !== undefined ? { position } : {}), words: [] };
    group.words.push(strip(w));
    groups.set(key, group);
  }
  return { kind: "attempts", sessionId: call.sessionId, groups: [...groups.values()] };
}

/**
 * Anki import file (tab separated, with the `#` header lines Anki 2.1.55+ reads): columns
 * Front, Back, Tags, unchanged since the queue shipped. Front is the word as it was met:
 * the effective as_met when one exists (おおぜい), else the text. Back carries the text
 * first when the front was the as-met form (大勢), then reading, meaning and the most
 * recent context. Tabs and newlines inside a field are flattened so each row stays one line.
 */
export function toAnkiTsv(rows: AnkiRow[]): string {
  const cell = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
  const lines = ["#separator:tab", "#html:true", "#columns:Front\tBack\tTags", "#tags column:3"];
  for (const r of rows) {
    const latest = r.sightings[r.sightings.length - 1];
    const asMet = effectiveAsMet(r.sightings);
    const back = [
      asMet ? cell(r.text) : null,
      r.reading ? `<b>${cell(r.reading)}</b>` : null,
      r.meaning ? cell(r.meaning) : null,
      latest?.context ? `<i>${cell(latest.context)}</i>` : null,
    ]
      .filter(Boolean)
      .join("<br>");
    const tags = ["jlpt-hub", `seen-${new Date(r.lastSeenAt).toISOString().slice(0, 7)}`].join(" ");
    lines.push([cell(asMet ?? r.text), back, tags].join("\t"));
  }
  return lines.join("\n") + "\n";
}

export function exportFilename(status: string, date = new Date()): string {
  return `jlpt-hub-queue-${status}-${date.toISOString().slice(0, 10)}.tsv`;
}
