import type { StudySourceKind } from "./types.ts";

/**
 * Pure helpers for the study-source catalog: resolving free text ("SKM N4 文法",
 * "新完全マスター 文法 N4 — 実力養成編 第1部 2課") to a catalog entry, deriving slugs for
 * new entries, and the placeholder palette. No DB imports so it runs under `node --test`;
 * lib/study-sources-db.ts loads the rows and wraps these.
 */

/** The subset of a study_sources row that resolution needs; any row-shaped object works. */
export interface SourceLike {
  id: string;
  slug: string;
  name: string;
  nameJa: string | null;
  aliases: string[] | null;
}

/**
 * Comparison key: Unicode-compatibility normalised (full-width Ｎ４ → N4), lower-cased, with
 * every whitespace character removed, so "新完全マスター文法" and "新完全マスター 文法" compare
 * equal and "Genki II" matches "genki ii".
 */
export function normalizeSourceText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** Keys shorter than this never take part in the substring step (avoids "N4"-style hits). */
const MIN_CONTAINS_KEY = 3;

function keysOf(source: SourceLike): string[] {
  const raw = [source.name, source.nameJa ?? "", ...(source.aliases ?? [])];
  return [...new Set(raw.map(normalizeSourceText).filter((k) => k.length > 0))];
}

/**
 * Resolve free text to one catalog source, or null when nothing (or more than one thing)
 * fits. The ladder, each step only reached when the previous found nothing:
 *
 * 1. slug, exactly (case-insensitive).
 * 2. name or nameJa, exactly.
 * 3. an alias, exactly.
 * 4. substring, both directions, over name / nameJa / aliases:
 *    - a key contained in the text ("新完全マスター 文法 N4" inside "新完全マスター 文法 N4 —
 *      実力養成編 第1部 2課"): the text names a source and adds detail. When several sources
 *      match this way, the one whose matched key is longest wins ("Genki II" beats "Genki I"
 *      inside "Genki II L14"); a tie between different sources is ambiguous.
 *    - the text contained in a key ("500 mon" inside "shin nihongo 500 mon n4-n5"): only
 *      counts when exactly one source matches, since a short text could mean several.
 *
 * Exact steps compare whole normalised strings, so "Genki" alone (contained in every Genki
 * entry) is ambiguous and returns null rather than guessing.
 */
export function resolveSource<T extends SourceLike>(sources: readonly T[], text: string | null | undefined): T | null {
  if (!text) return null;
  const q = normalizeSourceText(text);
  if (!q) return null;

  const bySlug = sources.find((s) => s.slug.toLowerCase() === q);
  if (bySlug) return bySlug;

  const byName = sources.filter((s) => {
    const names = [s.name, s.nameJa ?? ""].map(normalizeSourceText);
    return names.includes(q);
  });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;

  const byAlias = sources.filter((s) => (s.aliases ?? []).some((a) => normalizeSourceText(a) === q));
  if (byAlias.length === 1) return byAlias[0];
  if (byAlias.length > 1) return null;

  // Substring step. Forward: key inside text. Backward: text inside key.
  let bestLen = 0;
  let best: T[] = [];
  const backward: T[] = [];
  for (const s of sources) {
    let forwardLen = 0;
    let backwardHit = false;
    for (const key of keysOf(s)) {
      if (key.length < MIN_CONTAINS_KEY) continue;
      if (q.includes(key)) forwardLen = Math.max(forwardLen, key.length);
      else if (q.length >= MIN_CONTAINS_KEY && key.includes(q)) backwardHit = true;
    }
    if (forwardLen > 0) {
      if (forwardLen > bestLen) {
        bestLen = forwardLen;
        best = [s];
      } else if (forwardLen === bestLen) best.push(s);
    } else if (backwardHit) backward.push(s);
  }
  if (best.length === 1) return best[0];
  if (best.length > 1) return null;
  return backward.length === 1 ? backward[0] : null;
}

/**
 * URL/slug form of a display name: ASCII lower-case, hyphen-separated. Letters outside
 * ASCII (a Japanese-only name) are dropped; when nothing is left the caller falls back to
 * `fallback` (e.g. a short id) so the slug is never empty.
 */
export function slugify(name: string, fallback = "source"): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return ascii || fallback;
}

/** Split a comma- or newline-separated alias field into clean, de-duplicated aliases. */
export function parseAliases(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,、，]/u)) {
    const a = part.trim();
    if (!a) continue;
    const key = normalizeSourceText(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Placeholder-card palette for new sources; the seed assigns its own distinct colours. */
export const SOURCE_COLORS = [
  "#4f46e5", // indigo
  "#0f766e", // teal
  "#b45309", // amber
  "#be123c", // rose
  "#1d4ed8", // blue
  "#15803d", // green
  "#7c3aed", // violet
  "#c2410c", // orange
  "#0e7490", // cyan
  "#a21caf", // fuchsia
  "#475569", // slate
  "#854d0e", // brown
] as const;

export function isHexColor(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s);
}

/** Order the catalog grid groups its kinds in. */
export const SOURCE_KIND_ORDER: readonly StudySourceKind[] = [
  "textbook",
  "workbook",
  "question-bank",
  "official-test",
  "app",
  "reader",
];
