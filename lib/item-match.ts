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

/**
 * Tildes and whitespace dropped and ASCII parentheses folded to full-width, but (unlike
 * looseKey) a parenthetical sense label is kept: "〜と（条件）" and "と(条件)" agree, "と" does not.
 */
function strictKey(s: string): string {
  return s.replace(/[\s〜～~]+/gu, "").replace(/\(/g, "（").replace(/\)/g, "）");
}

/**
 * How a suggestion matched the query. "exact" is the same form as typed (tildes and spacing
 * aside); "exact-loose" is equal only once a parenthetical sense label is dropped (the
 * particle と for 〜と（条件）, or から（理由） for a bare から), so it ranks below every
 * literal hit. "prefix-only" means the item's form is merely a prefix of the query (まで for
 * 〜までに, 方/かた for かたづける): usually a different, shorter item, so it ranks below
 * every other kind of hit and should not be read as the one meant. "meaning" is a match on
 * the query's words: English words against the gloss, Japanese words in a mixed query
 * ("conditional と") against the item's forms.
 */
export type SuggestionMatch = "exact" | "exact-loose" | "extends" | "contains" | "prefix-only" | "meaning";

export interface ItemSuggestion {
  id: string;
  kind: ItemKind;
  level: JlptLevel;
  headword: string;
  reading: string;
  meaning: string;
  match?: SuggestionMatch;
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

/** Function words that say nothing about which item is meant. Commonness beyond these is handled by weighting. */
const MEANING_STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "and", "or", "is", "are", "be", "am", "was", "were", "do", "does", "did",
  "for", "in", "on", "at", "by", "it", "its", "as", "with", "from", "that", "this", "than", "someone", "something",
]);

/**
 * Romaji names of conjugated forms ("te-form") as the library spells them (て-form in a gloss)
 * plus the grammar form they point at (〜て（理由）'s loose key is て).
 */
const ROMAJI_FORMS: Record<string, string> = { te: "て", ta: "た", nai: "ない", masu: "ます", ba: "ば", tara: "たら" };

const HAS_ASCII_LETTER = /[a-z]/i;

/** One informative word of a query and the ways it can be found on an item. */
interface QueryToken {
  text: string;
  /** Matched against the item's English gloss. */
  meaning: RegExp[];
  /** Matched against headword/aliases/reading (Japanese words, and the form a romaji form name points at). */
  form: string | null;
  /** Restrict `form` hits to one kind ("te-form" names a grammar form, not the vocab 手 read て). */
  formKind: ItemKind | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word, case-insensitive, plural-tolerant both ways ("shoe" finds "shoes", "shoes"
 * finds "shoe"); a plural ending is only stripped while 4+ letters remain, so "news" never
 * becomes "new".
 */
function wordPattern(word: string): RegExp {
  const stems = new Set([word]);
  for (const end of ["s", "es"]) {
    if (word.endsWith(end) && word.length - end.length >= 4) stems.add(word.slice(0, -end.length));
  }
  const alt = [...stems].map(escapeRegExp).join("|");
  return new RegExp(`(?:^|[^a-z0-9])(?:${alt})(?:e?s)?(?=$|[^a-z0-9])`, "i");
}

/**
 * Split a query into informative tokens: on whitespace, commas and slashes, outer punctuation
 * stripped, stopwords and one-letter words dropped. A token with Latin letters is a gloss
 * word; a purely Japanese one is matched against forms.
 */
export function tokenizeQuery(query: string): QueryToken[] {
  const joined = query.replace(/\b(te|ta|nai|masu|ba|tara)[\s-]form\b/gi, (_, f: string) => `${f.toLowerCase()}-form`);
  const seen = new Set<string>();
  const out: QueryToken[] = [];
  for (const raw of joined.split(/[\s,、，;；/／・]+/u)) {
    const text = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const romaji = /^([a-z]+)-form$/.exec(text);
    if (romaji && ROMAJI_FORMS[romaji[1]]) {
      const kana = ROMAJI_FORMS[romaji[1]];
      out.push({ text, meaning: [wordPattern(text), wordPattern(`${kana}-form`)], form: kana, formKind: "grammar" });
    } else if (HAS_ASCII_LETTER.test(text)) {
      if (text.length < 2 || MEANING_STOPWORDS.has(text)) continue;
      out.push({ text, meaning: [wordPattern(text)], form: null, formKind: null });
    } else {
      out.push({ text, meaning: [], form: text, formKind: null });
    }
  }
  return out;
}

/**
 * Same form as the token (literal or loosened), or for 2+ characters a longer form starting
 * with it. A one-kana token is not tried against kana readings: と in "conditional と" means
 * the particle or the pattern, not 戸 or 都 that happen to be read と.
 */
function formHit(row: IndexRow, token: QueryToken): boolean {
  if (!token.form || (token.formKind && row.kind !== token.formKind)) return false;
  const strict = strictKey(token.form);
  const loose = looseKey(token.form);
  if (!loose) return false;
  const forms = [row.headword, ...(row.aliases ?? [])];
  if (loose.length >= 2) forms.push(row.reading);
  for (const form of forms) {
    if (!form) continue;
    const f = looseKey(form);
    if (strictKey(form) === strict || f === loose || (loose.length >= 2 && f.startsWith(loose))) return true;
  }
  return false;
}

interface TokenHit {
  /** Share of the query's informative weight this item accounts for, 0..1. */
  coverage: number;
  /** Tokens found on the item's forms rather than its gloss: the more specific evidence. */
  formHits: number;
}

/**
 * The minimum share of the query's weight an item must cover to be offered as a meaning hit.
 *
 * Each token is weighted by rarity across the library, ln(1 + N/df) with df = items it hits,
 * and tokens that hit nothing at all are dropped (a typo or a word the glosses never use
 * should not sink an otherwise good match). 0.5 means an item has to account for at least
 * half of the query's informative weight. In practice: a single-word query keeps every item
 * whose gloss has the word, as before; in "must, have to" the rare "must" (3 items) carries
 * 〜なければならない past the bar while the common "have" (8 items) alone does not, so
 * 持つ "to have" and friends stay out; in "conditional と" every conditional clears it only
 * together with と, so 〜と（条件） covers everything and ranks first. A raw count threshold
 * cannot tell those cases apart: one of two words is either always enough (the "have" items
 * flood the list) or never enough (〜なければならない is lost).
 */
const MEANING_COVERAGE_MIN = 0.5;

function tokenHits(index: ItemIndex, query: string): Map<string, TokenHit> {
  const hits = new Map<string, TokenHit>();
  if (!HAS_ASCII_LETTER.test(query)) return hits;
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return hits;
  const n = index.rows.length;
  // covered[t] = ids hit by token t, and whether via a form.
  const covered = tokens.map((token) => {
    const ids = new Map<string, boolean>();
    for (const row of index.rows) {
      if (formHit(row, token)) ids.set(row.id, true);
      else if (token.meaning.some((re) => re.test(row.meaning))) ids.set(row.id, false);
    }
    return ids;
  });
  const weights = covered.map((ids) => (ids.size > 0 ? Math.log(1 + n / ids.size) : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return hits;
  const acc = new Map<string, { weight: number; formHits: number }>();
  covered.forEach((ids, t) => {
    for (const [id, viaForm] of ids) {
      const entry = acc.get(id) ?? { weight: 0, formHits: 0 };
      entry.weight += weights[t];
      if (viaForm) entry.formHits += 1;
      acc.set(id, entry);
    }
  });
  for (const [id, { weight, formHits }] of acc) {
    const coverage = weight / total;
    // Float guard: a 50/50 split must not fall just short of the bar.
    if (coverage + 1e-9 >= MEANING_COVERAGE_MIN) hits.set(id, { coverage, formHits });
  }
  return hits;
}

/**
 * Near matches for a tag that did not resolve, or for a free-text lookup: hits on headword,
 * aliases and reading, then on the query's words, ranked exact > exact-loose (equal once a
 * parenthetical sense label is dropped) > extends (item form starts with the query) >
 * contains > meaning (by share of the query's words covered) > prefix-only (item form is a
 * strict prefix of the query), same kind first, N5 before N4. Pure; `findItemsBatch` is the
 * DB-backed wrapper.
 */
export function suggestItems(index: ItemIndex, query: string, opts: { kind?: ItemKind | null; limit?: number } = {}): ItemSuggestion[] {
  const limit = opts.limit ?? 5;
  const q = query.trim();
  const loose = looseKey(q);
  const strict = strictKey(q);
  if (!q) return [];

  const SCORE: Record<SuggestionMatch, number> = { exact: 100, "exact-loose": 80, extends: 60, contains: 40, meaning: 20, "prefix-only": 10 };
  const words = tokenHits(index, q);
  const scored: { row: IndexRow; score: number; match: SuggestionMatch; coverage: number; formHits: number }[] = [];
  for (const row of index.rows) {
    const forms = [row.headword, ...(row.aliases ?? []), row.reading].filter(Boolean);
    let best: SuggestionMatch | null = null;
    const consider = (m: SuggestionMatch) => {
      if (best === null || SCORE[m] > SCORE[best]) best = m;
    };
    for (const form of forms) {
      const f = looseKey(form);
      if (strict && strictKey(form) === strict) consider("exact");
      else if (loose && f === loose) consider("exact-loose");
      else if (loose && f.startsWith(loose)) consider("extends");
      else if (loose && f.includes(loose)) consider("contains");
      else if (loose && f.length >= 2 && loose.startsWith(f)) consider("prefix-only");
    }
    const word = words.get(row.id);
    if (best === null && word) best = "meaning";
    if (best === null) continue;
    let score = SCORE[best];
    // A different kind than the tag asked for is weaker evidence, not stronger.
    if (opts.kind) score += row.kind === opts.kind ? 5 : -5;
    const isMeaning = best === "meaning";
    scored.push({ row, score, match: best, coverage: isMeaning ? (word?.coverage ?? 0) : 0, formHits: isMeaning ? (word?.formHits ?? 0) : 0 });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.coverage - a.coverage ||
      b.formHits - a.formHits ||
      Number(b.row.level === "N5") - Number(a.row.level === "N5") ||
      a.row.headword.length - b.row.headword.length,
  );
  return scored.slice(0, limit).map((s) => ({ ...toSuggestion(s.row), match: s.match }));
}

/** Resolve free text to an item of any kind (headword, alias, kana reading, loosened pattern). */
export function matchText(index: ItemIndex, text: string): string | null {
  const t = text.trim();
  return t ? lookup(index.all, t, null) : null;
}

/**
 * The library items a topic word is about, for get_insights: the item it resolves to as a
 * tag, every item with the same form (exact or exact-loose: から means both から senses), and
 * for a topic of two or more characters the grammar patterns that merely add an ending to it
 * (はず -> 〜はずだ, ほど -> 〜ほど〜ない). Vocab that only starts with the topic is left out, so
 * はず never pulls in はずかしい.
 */
export function topicItemIds(index: ItemIndex, topic: string): string[] {
  const t = topic.trim();
  if (!t) return [];
  const ids = new Set<string>();
  const resolved = matchText(index, t);
  if (resolved) ids.add(resolved);
  const longEnough = looseKey(t).length >= 2;
  for (const s of suggestItems(index, t, { limit: 25 })) {
    if (s.match === "exact" || s.match === "exact-loose" || (longEnough && s.match === "extends" && s.kind === "grammar")) ids.add(s.id);
  }
  return [...ids];
}

export interface FindItemsResult {
  query: string;
  /**
   * The item this text resolves to as-is when used as a tag (the same ladder log_attempts
   * runs, with `kind` as the tag's kind when given), or null when it would stay unresolved.
   */
  resolves: { id: string; headword: string } | null;
  items: ItemSuggestion[];
}

/** One find_items answer: does the text resolve as a tag, and the ranked near matches. */
export function findInIndex(index: ItemIndex, query: string, opts: { kind?: ItemKind | null; limit?: number } = {}): FindItemsResult {
  const kind = opts.kind ?? null;
  const id = kind ? matchTag(index, { kind, text: query }) : matchText(index, query);
  const row = id ? index.byId.get(id) : undefined;
  return {
    query,
    resolves: row ? { id: row.id, headword: row.headword } : null,
    items: suggestItems(index, query, { kind, limit: opts.limit }),
  };
}
