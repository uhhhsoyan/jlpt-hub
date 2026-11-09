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

/** Appends a sighting unless the same question (or the same moment and context) is already recorded; newest last, capped. */
export function mergeSightings(existing: VocabSighting[], next: VocabSighting, max = 20): VocabSighting[] {
  const dup = existing.some((s) =>
    next.questionId ? s.questionId === next.questionId : s.at === next.at && s.context === next.context,
  );
  if (dup) return existing;
  const out = [...existing, next];
  return out.length > max ? out.slice(out.length - max) : out;
}

/** A word that stalls again is worth a card unless one already exists. */
export function statusOnResight(status: VocabQueueStatus): VocabQueueStatus {
  return status === "carded" ? "carded" : "queued";
}

/**
 * Anki import file (tab separated, with the `#` header lines Anki 2.1.55+ reads): columns
 * front, back, tags. Back carries reading, meaning and the most recent context; tabs and
 * newlines inside a field are flattened so each row stays one line.
 */
export function toAnkiTsv(rows: AnkiRow[]): string {
  const cell = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
  const lines = ["#separator:tab", "#html:true", "#columns:Front\tBack\tTags", "#tags column:3"];
  for (const r of rows) {
    const latest = r.sightings[r.sightings.length - 1];
    const back = [
      r.reading ? `<b>${cell(r.reading)}</b>` : null,
      r.meaning ? cell(r.meaning) : null,
      latest?.context ? `<i>${cell(latest.context)}</i>` : null,
    ]
      .filter(Boolean)
      .join("<br>");
    const tags = ["jlpt-hub", `seen-${new Date(r.lastSeenAt).toISOString().slice(0, 7)}`].join(" ");
    lines.push([cell(r.text), back, tags].join("\t"));
  }
  return lines.join("\n") + "\n";
}

export function exportFilename(status: string, date = new Date()): string {
  return `jlpt-hub-queue-${status}-${date.toISOString().slice(0, 10)}.tsv`;
}
