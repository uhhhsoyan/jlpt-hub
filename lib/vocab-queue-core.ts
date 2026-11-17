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

/** A word that stalls again is worth a card unless one already exists. */
export function statusOnResight(status: VocabQueueStatus): VocabQueueStatus {
  return status === "carded" ? "carded" : "queued";
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
