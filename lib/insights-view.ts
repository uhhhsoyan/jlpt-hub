import { insightMatch, matchInsights, type InsightMatch } from "./insight-match.ts";
import { normalizeGrammar } from "./item-match.ts";
import { feedDay } from "./study-feed.ts";
import type { InsightSource, ItemKind, QuestionTag } from "./types.ts";

/**
 * The Insights page (/insights): every logged insight as a body of knowledge, filterable by
 * free text, tags and item, with a tag navigator, a "what keeps coming up" item index and a
 * printable review sheet. Pure (no DB, no path aliases) so it unit-tests under plain
 * `node --test`; lib/insights-db.ts loads the rows and calls assembleInsights.
 */

// ---- Input ----------------------------------------------------------------------------------

export interface InsightRecord {
  id: string;
  text: string;
  tags: string[];
  /** Item references as logged; itemId null where nothing in the library matched. */
  items: QuestionTag[];
  source: InsightSource;
  createdAt: Date;
}

/** The library fields the page shows for a linked item. */
export interface ItemInfo {
  id: string;
  kind: ItemKind;
  headword: string;
  reading: string;
  meaning: string;
}

// ---- URL state ------------------------------------------------------------------------------

export type InsightsView = "list" | "sheet";

export interface InsightsQuery {
  /** Free-text search over text, tags and item texts. */
  q: string | null;
  /** AND-filter, case-insensitive. */
  tags: string[];
  /** A library item id, or an item's text (as logged or its headword). */
  item: string | null;
  view: InsightsView;
}

export const NO_INSIGHTS_QUERY: InsightsQuery = { q: null, tags: [], item: null, view: "list" };

const MAX_PARAM = 100;
const MAX_TAGS = 10;

type Params = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  const s = (Array.isArray(v) ? v[0] : v)?.trim().slice(0, MAX_PARAM);
  return s || null;
}

/** `?q=…&tag=a&tag=b,c&item=…&view=sheet`; tags may repeat or be comma-separated. */
export function parseInsightsQuery(params: Params): InsightsQuery {
  const raw = params.tag === undefined ? [] : Array.isArray(params.tag) ? params.tag : [params.tag];
  const tags: string[] = [];
  for (const t of raw.flatMap((v) => v.split(","))) {
    const tag = t.trim().slice(0, MAX_PARAM);
    if (tag && !tags.some((x) => x.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return {
    q: first(params.q),
    tags: tags.slice(0, MAX_TAGS),
    item: first(params.item),
    view: first(params.view) === "sheet" ? "sheet" : "list",
  };
}

export function isFiltered(q: InsightsQuery): boolean {
  return q.q !== null || q.tags.length > 0 || q.item !== null;
}

/** The page URL for a query; defaults are left out so the bare page stays "/insights". */
export function insightsHref(query: Partial<InsightsQuery> = {}): string {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  for (const t of query.tags ?? []) p.append("tag", t);
  if (query.item) p.set("item", query.item);
  if (query.view === "sheet") p.set("view", "sheet");
  const s = p.toString();
  return s ? `/insights?${s}` : "/insights";
}

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function hasTag(query: InsightsQuery, tag: string): boolean {
  return query.tags.some((t) => sameTag(t, tag));
}

/** Add a tag to the AND-filter (a no-op when it is already there). */
export function withTag(query: InsightsQuery, tag: string): InsightsQuery {
  return hasTag(query, tag) ? query : { ...query, tags: [...query.tags, tag] };
}

export function withoutTag(query: InsightsQuery, tag: string): InsightsQuery {
  return { ...query, tags: query.tags.filter((t) => !sameTag(t, tag)) };
}

// ---- Matching -------------------------------------------------------------------------------

/** One form of an item's text for comparing: width-folded, tildes, spaces and a trailing sense label dropped. */
export function itemKey(text: string): string {
  return normalizeGrammar(text.normalize("NFKC"))
    .replace(/[\s〜～~]+/gu, "")
    .toLowerCase();
}

interface Candidate {
  rec: InsightRecord;
  text: string;
  tags: string[];
  itemIds: string[];
  createdAt: Date;
}

/**
 * insightMatch (linked item via topicItemIds, exact tag, text) widened to the item texts as
 * logged, which matter for items the library has not matched: an item written the same as
 * the query counts as an item hit, a tag containing a query of 3+ characters as a tag hit
 * ("polar" finds #polarity), and an item text merely containing it as a text hit.
 */
function searchMatch(row: Candidate, topic: string, topicItemIds: string[]): InsightMatch | null {
  const base = insightMatch(row, topic, topicItemIds);
  if (base === "item") return base;
  const key = itemKey(topic);
  if (key && row.rec.items.some((i) => itemKey(i.text) === key)) return "item";
  if (base === "tag") return base;
  const t = topic.trim().toLowerCase();
  if (t.length >= 3 && row.tags.some((tag) => tag.toLowerCase().includes(t))) return "tag";
  if (base) return base;
  return row.rec.items.some((i) => i.text.toLowerCase().includes(t)) ? "text" : null;
}

interface ItemFilter {
  ids: Set<string>;
  keys: Set<string>;
  label: string;
  info: ItemInfo | null;
}

/**
 * What `?item=` selects. A library id selects that item. Any other text selects insights
 * whose items are written the same way (itemKey), plus every library item that text is
 * linked to anywhere or is the headword of, so ?item=はずだ also finds a note linked to 〜はずだ.
 */
function resolveItemFilter(item: string, rows: InsightRecord[], itemsById: Map<string, ItemInfo>): ItemFilter {
  const byId = itemsById.get(item);
  if (byId) return { ids: new Set([item]), keys: new Set(), label: byId.headword, info: byId };
  const loggedWithId = rows.flatMap((r) => r.items).find((i) => i.itemId === item);
  if (loggedWithId) return { ids: new Set([item]), keys: new Set(), label: loggedWithId.text, info: null };

  const key = itemKey(item);
  const ids = new Set<string>();
  for (const i of rows.flatMap((r) => r.items)) if (i.itemId && itemKey(i.text) === key) ids.add(i.itemId);
  for (const info of itemsById.values()) if (itemKey(info.headword) === key) ids.add(info.id);
  const info = ids.size === 1 ? (itemsById.get([...ids][0]) ?? null) : null;
  return { ids, keys: new Set(key ? [key] : []), label: info?.headword ?? item, info };
}

function aboutItem(rec: InsightRecord, f: ItemFilter): boolean {
  return rec.items.some((i) => (i.itemId !== null && f.ids.has(i.itemId)) || f.keys.has(itemKey(i.text)));
}

// ---- Tags -----------------------------------------------------------------------------------

export interface TagCount {
  tag: string;
  n: number;
}

/**
 * Insights per tag, case-insensitive (one insight counts once per tag); each tag is shown
 * in the spelling used most. Most used first, then alphabetical.
 */
export function countTags(rows: { tags: string[] }[]): TagCount[] {
  const groups = new Map<string, { n: number; spellings: Map<string, number> }>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const raw of row.tags) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      const g = groups.get(key) ?? { n: 0, spellings: new Map<string, number>() };
      g.n += 1;
      g.spellings.set(tag, (g.spellings.get(tag) ?? 0) + 1);
      groups.set(key, g);
    }
  }
  return [...groups.values()]
    .map((g) => ({ tag: [...g.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], n: g.n }))
    .sort(byCountThenTag);
}

function byCountThenTag(a: TagCount, b: TagCount): number {
  return b.n - a.n || a.tag.localeCompare(b.tag);
}

/** `skm-l12`, `SKM_L3`, `genki-lesson-4`: a series name, a separator, l/lesson, a number. */
const LESSON_TAG = /^([a-z][a-z0-9]*)[-_ ](?:l|lesson)[-_ ]?(\d{1,3})$/i;

export function parseLessonTag(tag: string): { series: string; lesson: number } | null {
  const m = LESSON_TAG.exec(tag.trim());
  return m ? { series: m[1].toLowerCase(), lesson: Number(m[2]) } : null;
}

/** "skm" -> "SKM" (short names read as acronyms), "genki" -> "Genki". */
export function seriesLabel(series: string): string {
  return series.length <= 4 ? series.toUpperCase() : series[0].toUpperCase() + series.slice(1);
}

export interface LessonTag extends TagCount {
  lesson: number;
}

export interface LessonSeries {
  series: string;
  label: string;
  /** In lesson order (L2 before L10). */
  lessons: LessonTag[];
  /** Total tag uses across the series. */
  n: number;
}

export interface TagGroups {
  /** Lesson tags, one strip per textbook series, the most used series first. */
  series: LessonSeries[];
  /** The most used topic tags, shown up front. */
  topics: TagCount[];
  /** The long tail, behind a "more" disclosure. */
  more: TagCount[];
}

export const TOPIC_TAGS_SHOWN = 20;

/** Split tag counts into lesson strips and topic tags (head + tail), from the tag names alone. */
export function groupTags(counts: TagCount[], topicLimit: number = TOPIC_TAGS_SHOWN): TagGroups {
  const series = new Map<string, LessonSeries>();
  const topics: TagCount[] = [];
  for (const c of counts) {
    const lesson = parseLessonTag(c.tag);
    if (!lesson) {
      topics.push(c);
      continue;
    }
    const s = series.get(lesson.series) ?? { series: lesson.series, label: seriesLabel(lesson.series), lessons: [], n: 0 };
    s.lessons.push({ ...c, lesson: lesson.lesson });
    s.n += c.n;
    series.set(lesson.series, s);
  }
  for (const s of series.values()) s.lessons.sort((a, b) => a.lesson - b.lesson || a.tag.localeCompare(b.tag));
  topics.sort(byCountThenTag);
  return {
    series: [...series.values()].sort((a, b) => b.n - a.n || a.series.localeCompare(b.series)),
    topics: topics.slice(0, topicLimit),
    more: topics.slice(topicLimit),
  };
}

// ---- Output ---------------------------------------------------------------------------------

export interface CardItem {
  /** As logged. */
  text: string;
  itemId: string | null;
  /** The `?item=` value that filters to this item: its id when linked, else its text. */
  param: string;
}

export interface InsightCard {
  id: string;
  text: string;
  tags: string[];
  items: CardItem[];
  source: InsightSource;
  /** The journal day it was logged on (learner's zone; see feedDay). */
  day: string;
  /** Why it matched `q`; absent without a search. */
  matched?: InsightMatch;
}

export interface ItemIndexEntry {
  param: string;
  label: string;
  reading: string | null;
  meaning: string | null;
  linked: boolean;
  /** Insights about it. */
  n: number;
}

export interface SheetEntry {
  card: InsightCard;
  /** Other items the insight is about, by headword. */
  also: string[];
}

export interface SheetGroup {
  key: string;
  kind: "item" | "tag" | "general";
  title: string;
  /** Kana reading for a vocab or kanji headword; null for grammar and tag groups. */
  reading: string | null;
  meaning: string | null;
  /** Filter link for the group: `?item=` for an item group, `?tag=` for a tag group. */
  query: Partial<InsightsQuery> | null;
  entries: SheetEntry[];
}

export interface ActiveItem {
  param: string;
  label: string;
  meaning: string | null;
  /** Library ids the filter resolved to (so the item index can mark the entry it means). */
  ids: string[];
}

export interface InsightsPage {
  query: InsightsQuery;
  /** Every insight, before filters. */
  total: number;
  /** The selection, ranked (search tier, then newest first). */
  cards: InsightCard[];
  activeItem: ActiveItem | null;
  tagGroups: TagGroups;
  itemIndex: ItemIndexEntry[];
  /** Only for the sheet view. */
  sheet: SheetGroup[] | null;
}

function cardItems(items: QuestionTag[]): CardItem[] {
  const out: CardItem[] = [];
  for (const i of items) {
    const text = i.text.trim();
    if (!text || out.some((o) => o.text === text)) continue;
    out.push({ text, itemId: i.itemId, param: i.itemId ?? text });
  }
  return out;
}

const readingFor = (info: ItemInfo | undefined | null): string | null =>
  info && info.kind !== "grammar" && info.reading && info.reading !== info.headword ? info.reading : null;

/** Items with the most insights about them (linked by id, unlinked by written form); 2+ only. */
export function topItems(rows: InsightRecord[], itemsById: Map<string, ItemInfo>, limit = 12): ItemIndexEntry[] {
  const tally = new Map<string, ItemIndexEntry>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const i of row.items) {
      const text = i.text.trim();
      const key = i.itemId ? `id:${i.itemId}` : `text:${itemKey(text)}`;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const info = i.itemId ? itemsById.get(i.itemId) : undefined;
      const e = tally.get(key) ?? {
        param: i.itemId ?? text,
        label: info?.headword ?? text,
        reading: readingFor(info),
        meaning: info?.meaning ?? null,
        linked: i.itemId !== null,
        n: 0,
      };
      e.n += 1;
      tally.set(key, e);
    }
  }
  return [...tally.values()]
    .filter((e) => e.n >= 2)
    .sort((a, b) => b.n - a.n || Number(b.linked) - Number(a.linked) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * The review sheet: the selection grouped by grammar point. Each insight goes under one of
 * its linked items, the one most of the selection is about (ties: the first it names), so
 * related notes land together and none repeats. Insights with no linked item go under their
 * first tag, or "General" with no tags. Item groups first (largest first), then tag groups,
 * then General; entries keep the selection's order.
 */
export function sheetGroups(cards: InsightCard[], itemsById: Map<string, ItemInfo>): SheetGroup[] {
  const linkedIds = (c: InsightCard) => [...new Set(c.items.filter((i) => i.itemId).map((i) => i.itemId as string))];
  const uses = new Map<string, number>();
  for (const c of cards) for (const id of linkedIds(c)) uses.set(id, (uses.get(id) ?? 0) + 1);

  const groups = new Map<string, SheetGroup>();
  const order: string[] = [];
  const add = (key: string, make: () => Omit<SheetGroup, "entries">, entry: SheetEntry) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...make(), entries: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.entries.push(entry);
  };

  for (const card of cards) {
    const ids = linkedIds(card);
    if (ids.length > 0) {
      const primary = ids.reduce((best, id) => ((uses.get(id) ?? 0) > (uses.get(best) ?? 0) ? id : best), ids[0]);
      const info = itemsById.get(primary);
      const logged = card.items.find((i) => i.itemId === primary)?.text ?? primary;
      const also = card.items.filter((i) => i.itemId !== primary).map((i) => (i.itemId ? (itemsById.get(i.itemId)?.headword ?? i.text) : i.text));
      add(
        `item:${primary}`,
        () => ({
          key: `item:${primary}`,
          kind: "item",
          title: info?.headword ?? logged,
          reading: readingFor(info),
          meaning: info?.meaning ?? null,
          query: { item: primary },
        }),
        { card, also: [...new Set(also)] },
      );
      continue;
    }
    const also = card.items.map((i) => i.text);
    const tag = card.tags.find((t) => t.trim());
    if (tag) {
      const key = `tag:${tag.trim().toLowerCase()}`;
      add(key, () => ({ key, kind: "tag", title: `#${tag.trim()}`, reading: null, meaning: null, query: { tags: [tag.trim()] } }), { card, also });
    } else {
      add("general", () => ({ key: "general", kind: "general", title: "General", reading: null, meaning: null, query: null }), { card, also });
    }
  }

  const rank = { item: 0, tag: 1, general: 2 } as const;
  return order
    .map((key, i) => ({ g: groups.get(key) as SheetGroup, i }))
    .sort((a, b) => rank[a.g.kind] - rank[b.g.kind] || b.g.entries.length - a.g.entries.length || a.i - b.i)
    .map(({ g }) => g);
}

export interface AssembleOptions {
  /** Library items the search text is about (topicItemIds in lib/item-match.ts); only used with `q`. */
  topicItemIds?: string[];
  timeZone?: string;
}

/**
 * Rows -> the page: filter by item, tags (AND) and search, rank (item and tag hits above
 * text-only hits, newest first within each), and build the tag navigator, item index and
 * (sheet view) the grouped review sheet. Tag counts and the item index cover every insight,
 * not just the selection, so they stay a stable map of the whole set.
 */
export function assembleInsights(
  rows: InsightRecord[],
  items: ItemInfo[],
  query: InsightsQuery,
  opts: AssembleOptions = {},
): InsightsPage {
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const itemFilter = query.item ? resolveItemFilter(query.item, rows, itemsById) : null;

  const candidates: Candidate[] = rows
    .filter((rec) => !itemFilter || aboutItem(rec, itemFilter))
    .map((rec) => ({
      rec,
      text: rec.text,
      tags: rec.tags,
      itemIds: rec.items.filter((i) => i.itemId).map((i) => i.itemId as string),
      createdAt: rec.createdAt,
    }));

  const ranked = matchInsights(candidates, { topic: query.q, topicItemIds: opts.topicItemIds ?? [], tags: query.tags }, searchMatch);
  const cards: InsightCard[] = ranked.map(({ row: { rec }, matched }) => ({
    id: rec.id,
    text: rec.text.trim(),
    tags: rec.tags.map((t) => t.trim()).filter(Boolean),
    items: cardItems(rec.items),
    source: rec.source,
    day: feedDay(rec.createdAt, opts.timeZone),
    ...(matched ? { matched } : {}),
  }));

  return {
    query,
    total: rows.length,
    cards,
    activeItem:
      itemFilter && query.item ? { param: query.item, label: itemFilter.label, meaning: itemFilter.info?.meaning ?? null, ids: [...itemFilter.ids] } : null,
    tagGroups: groupTags(countTags(rows)),
    itemIndex: topItems(rows, itemsById),
    sheet: query.view === "sheet" ? sheetGroups(cards, itemsById) : null,
  };
}
