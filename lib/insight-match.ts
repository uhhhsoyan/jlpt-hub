/**
 * Pure filtering and ranking for get_insights (no DB imports, so it runs under `node --test`);
 * lib/ledger.ts getInsights loads the candidate rows and hands them here.
 */

/**
 * Why an insight matched the topic: "item" (linked to the library item the topic resolves
 * to), "tag" (carries the topic as a tag, case-insensitive), or "text" (the topic only
 * appears somewhere in the text). A text-only hit can be a coincidence: topic はず also
 * finds はずかしい, so callers should discount it.
 */
export type InsightMatch = "item" | "tag" | "text";

export interface InsightCandidate {
  text: string;
  tags: string[];
  itemIds: string[];
  createdAt: Date;
}

export interface InsightFilter {
  topic?: string | null;
  /** The library items the topic is about (topicItemIds in lib/item-match.ts). */
  topicItemIds?: string[];
  /** AND-filter: only insights carrying every one of these tags (case-insensitive). */
  tags?: string[] | null;
  limit?: number;
}

export interface RankedInsight<T> {
  row: T;
  /** Absent when no topic was given. */
  matched?: InsightMatch;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** How (and whether) one insight matches the topic; the strongest reason wins. */
export function insightMatch(row: InsightCandidate, topic: string, topicItemIds: string[] = []): InsightMatch | null {
  const t = norm(topic);
  if (!t) return null;
  if (row.itemIds.some((id) => topicItemIds.includes(id))) return "item";
  if (row.tags.some((tag) => norm(tag) === t)) return "tag";
  if (row.text.toLowerCase().includes(t)) return "text";
  return null;
}

/** Decides whether (and why) one insight matches the topic; insightMatch by default. */
export type InsightMatcher<T extends InsightCandidate> = (row: T, topic: string, topicItemIds: string[]) => InsightMatch | null;

/**
 * Keep the insights that carry every requested tag and match the topic (when given), then
 * order linked-item and exact-tag matches first and text-only matches after them, newest
 * first within each group. Text matches are never dropped, only ranked below. No limit:
 * the Insights page ranks the whole set; get_insights goes through rankInsights.
 */
export function matchInsights<T extends InsightCandidate>(
  rows: T[],
  filter: Omit<InsightFilter, "limit"> = {},
  matcher: InsightMatcher<T> = insightMatch,
): RankedInsight<T>[] {
  const topic = filter.topic?.trim() || null;
  const wanted = [...new Set((filter.tags ?? []).map(norm).filter(Boolean))];

  const kept: RankedInsight<T>[] = [];
  for (const row of rows) {
    if (wanted.length > 0) {
      const have = new Set(row.tags.map(norm));
      if (!wanted.every((t) => have.has(t))) continue;
    }
    if (!topic) {
      kept.push({ row });
      continue;
    }
    const matched = matcher(row, topic, filter.topicItemIds ?? []);
    if (matched) kept.push({ row, matched });
  }
  const tier = (r: RankedInsight<T>) => (r.matched === "text" ? 1 : 0);
  kept.sort((a, b) => tier(a) - tier(b) || b.row.createdAt.getTime() - a.row.createdAt.getTime());
  return kept;
}

/** matchInsights for get_insights: the same ranking, cut to `limit` (default 20, 1-100). */
export function rankInsights<T extends InsightCandidate>(rows: T[], filter: InsightFilter = {}): RankedInsight<T>[] {
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
  return matchInsights(rows, filter).slice(0, limit);
}
