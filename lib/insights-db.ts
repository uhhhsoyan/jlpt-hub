import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { insights, items } from "@/lib/db/schema";
import { topicItemIds } from "@/lib/item-match";
import { loadItemIndex } from "@/lib/resolve-items";
import { assembleInsights, type InsightsPage, type InsightsQuery, type ItemInfo } from "@/lib/insights-view";

/**
 * The Insights page: SELECTs only, two queries in parallel whatever the filters (every
 * insight, and the library fields of the items they link to). With a search, the second
 * query is the whole item index instead, because ranking needs the items the search text
 * is about (topicItemIds, the same rule as get_insights). Filtering, ranking, tag grouping
 * and the review sheet live in lib/insights-view.ts.
 */
export async function loadInsightsPage(query: InsightsQuery): Promise<InsightsPage> {
  const db = getDb();
  const rowsQuery = db
    .select({
      id: insights.id,
      text: insights.text,
      tags: insights.tags,
      items: insights.items,
      source: insights.source,
      createdAt: insights.createdAt,
    })
    .from(insights);

  if (query.q) {
    const [rows, index] = await Promise.all([rowsQuery, loadItemIndex()]);
    const linked = new Set(rows.flatMap((r) => r.items.map((i) => i.itemId)));
    const info: ItemInfo[] = index.rows.filter((r) => linked.has(r.id));
    return assembleInsights(rows, info, query, { topicItemIds: topicItemIds(index, query.q) });
  }

  const [rows, info] = await Promise.all([
    rowsQuery,
    db
      .select({ id: items.id, kind: items.kind, headword: items.headword, reading: items.reading, meaning: items.meaning })
      .from(items)
      .where(sql`${items.id}::text IN (SELECT jsonb_array_elements_text(${insights.itemIds}) FROM ${insights})`),
  ]);
  return assembleInsights(rows, info, query);
}
