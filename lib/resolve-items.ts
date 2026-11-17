import { getDb } from "@/lib/db";
import { items } from "@/lib/db/schema";
import type { ExtractedTag, ItemKind, QuestionTag } from "@/lib/types";
import { createItemIndex, findInIndex, matchTag, type FindItemsResult, type ItemIndex } from "@/lib/item-match";

export { normalizeGrammar, type FindItemsResult, type ItemIndex, type ItemSuggestion, type IndexRow } from "@/lib/item-match";

export async function loadItemIndex(): Promise<ItemIndex> {
  const rows = await getDb()
    .select({
      id: items.id,
      kind: items.kind,
      level: items.level,
      headword: items.headword,
      reading: items.reading,
      meaning: items.meaning,
      aliases: items.aliases,
    })
    .from(items);
  return createItemIndex(rows);
}

/**
 * Resolve extracted tags against the `items` table (see matchTag for the ladder). One DB
 * round-trip; order is preserved 1:1 with the input so callers can re-slice per question.
 */
export async function resolveTags(tags: ExtractedTag[], index?: ItemIndex): Promise<QuestionTag[]> {
  if (tags.length === 0) return [];
  const idx = index ?? (await loadItemIndex());
  return tags.map((tag) => ({ kind: tag.kind, text: tag.text, itemId: matchTag(idx, tag) }));
}

/**
 * Free-text library lookups for the MCP `find_items` tool, one or many over a single index
 * load (a lesson's patterns confirmed in one call).
 */
export async function findItemsBatch(queries: string[], opts: { kind?: ItemKind | null; limit?: number } = {}): Promise<FindItemsResult[]> {
  const index = await loadItemIndex();
  return queries.map((q) => findInIndex(index, q, { kind: opts.kind ?? null, limit: opts.limit ?? 8 }));
}
