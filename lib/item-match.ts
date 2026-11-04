import type { ExtractedTag, ItemKind, JlptLevel } from "./types.ts";

/**
 * Pure tag-to-item matching over an in-memory index of the items table. No DB imports so
 * it runs under `node --test`; lib/resolve-items.ts loads the index and wraps these.
 */

/** Pure kana (hiragana + katakana, incl. the prolonged-sound mark) — used to try a reading match for vocab tags. */
const KANA_ONLY = /^[぀-ゟ゠-ヿ]+$/u;

/**
 * Loosen a grammar pattern for matching: drop a trailing parenthetical disambiguator
 * ("に (time)" -> "に"), strip any leading/trailing tilde variant (〜/～/~), and outer
 * whitespace. Mirrors scripts/backfill-workshop.mjs's normalizePattern exactly, so both
 * paths agree on what "the same grammar point" means.
 */
export function normalizeGrammar(s: string): string {
  return s
    .replace(/[（(][^（()）]*[)）]\s*$/u, "")
    .replace(/^[\s〜～~]+/u, "")
    .replace(/[\s〜～~]+$/u, "");
}

/** Collapse every tilde variant and whitespace so "〜ほど 〜ない" and "ほど〜ない" compare equal. */
function looseKey(s: string): string {
  return normalizeGrammar(s).replace(/[\s〜～~]+/gu, "");
}

export interface IndexRow {
  id: string;
  kind: ItemKind;
  level: JlptLevel;
  headword: string;
  reading: string;
  meaning: string;
  aliases: string[] | null;
}

export interface ItemSuggestion {
  id: string;
  kind: ItemKind;
  level: JlptLevel;
  headword: string;
  reading: string;
  meaning: string;
}

/** key -> ids sharing that key; only a single id means an unambiguous match. */
function groupIds(rows: IndexRow[], keyFn: (r: IndexRow) => string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    for (const key of new Set(keyFn(row))) {
      if (!key) continue;
      const list = map.get(key);
      if (list) {
        if (!list.includes(row.id)) list.push(row.id);
      } else map.set(key, [row.id]);
    }
  }
  return map;
}

function uniqueId(ids: string[] | undefined): string | null {
  return ids && ids.length === 1 ? ids[0] : null;
}

/**
 * Everything matching needs, built once per request from the items table (a few thousand
 * rows at most). Exposed so the pure matching functions can be unit-tested without a DB.
 */
export interface ItemIndex {
  rows: IndexRow[];
  byId: Map<string, IndexRow>;
  /** Per kind: exact headword, exact alias, kana reading (vocab), loosened pattern (grammar + aliases). */
  perKind: Record<ItemKind, { headword: Map<string, string[]>; alias: Map<string, string[]>; reading: Map<string, string[]>; loose: Map<string, string[]> }>;
  /** Across every kind, for the fallback when a tag's own kind has nothing. */
  all: { headword: Map<string, string[]>; alias: Map<string, string[]>; reading: Map<string, string[]>; loose: Map<string, string[]> };
}

const KINDS: ItemKind[] = ["vocab", "kanji", "grammar"];

function buildMaps(rows: IndexRow[]) {
  return {
    headword: groupIds(rows, (r) => [r.headword]),
    alias: groupIds(rows, (r) => r.aliases ?? []),
    reading: groupIds(rows, (r) => (r.kind === "vocab" && r.reading ? [r.reading] : [])),
    loose: groupIds(rows, (r) => [looseKey(r.headword), ...(r.aliases ?? []).map(looseKey)]),
  };
}

export function createItemIndex(rows: IndexRow[]): ItemIndex {
  const perKind = {} as ItemIndex["perKind"];
  for (const kind of KINDS) perKind[kind] = buildMaps(rows.filter((r) => r.kind === kind));
  return { rows, byId: new Map(rows.map((r) => [r.id, r])), perKind, all: buildMaps(rows) };
}

function lookup(maps: ItemIndex["all"], text: string, kind: ItemKind | null): string | null {
  const loose = looseKey(text);
  return (
    uniqueId(maps.headword.get(text)) ??
    uniqueId(maps.alias.get(text)) ??
    ((kind === null || kind === "vocab") && KANA_ONLY.test(text) ? uniqueId(maps.reading.get(text)) : null) ??
    (loose ? uniqueId(maps.loose.get(loose)) : null)
  );
}

/**
 * Match one tag against the index:
 * 1. within the tag's own kind: exact headword, exact alias, kana reading (vocab), then
 *    the loosened form (tildes/spaces/parentheticals dropped) against headwords and aliases;
 * 2. the same ladder across every kind, for tags filed under the wrong kind
 *    ("どちら" as grammar when the library holds it as vocab).
 * Every step accepts only a unique hit, so an ambiguous spelling stays unresolved rather
 * than guessing (the caller gets suggestions instead).
 */
export function matchTag(index: ItemIndex, tag: ExtractedTag): string | null {
  const text = tag.text.trim();
  if (!text) return null;
  return lookup(index.perKind[tag.kind], text, tag.kind) ?? lookup(index.all, text, null);
}

export function toSuggestion(row: IndexRow): ItemSuggestion {
  return { id: row.id, kind: row.kind, level: row.level, headword: row.headword, reading: row.reading, meaning: row.meaning };
}

/**
 * Near matches for a tag that did not resolve, or for a free-text lookup: substring hits on
 * headword, aliases, reading and meaning, ranked exact > starts-with > contains, same kind
 * first, N5 before N4. Pure; `findItems` is the DB-backed wrapper.
 */
export function suggestItems(index: ItemIndex, query: string, opts: { kind?: ItemKind | null; limit?: number } = {}): ItemSuggestion[] {
  const limit = opts.limit ?? 5;
  const q = query.trim();
  const loose = looseKey(q);
  const lower = q.toLowerCase();
  if (!q) return [];

  const scored: { row: IndexRow; score: number }[] = [];
  for (const row of index.rows) {
    const forms = [row.headword, ...(row.aliases ?? []), row.reading].filter(Boolean);
    let best = 0;
    for (const form of forms) {
      const f = looseKey(form);
      if (form === q || (loose && f === loose)) best = Math.max(best, 100);
      else if (loose && (f.startsWith(loose) || loose.startsWith(f) && f.length >= 2)) best = Math.max(best, 60);
      else if (loose && f.includes(loose)) best = Math.max(best, 40);
    }
    if (best === 0 && lower.length >= 3 && row.meaning.toLowerCase().includes(lower)) best = 20;
    if (best === 0) continue;
    if (opts.kind && row.kind === opts.kind) best += 5;
    if (row.level === "N5") best += 1;
    scored.push({ row, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.row.headword.length - b.row.headword.length);
  return scored.slice(0, limit).map((s) => toSuggestion(s.row));
}

/** Resolve free text to an item of any kind (headword, alias, kana reading, loosened pattern). */
export function matchText(index: ItemIndex, text: string): string | null {
  const t = text.trim();
  return t ? lookup(index.all, t, null) : null;
}
