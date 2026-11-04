import { getDb } from "@/lib/db";
import { items } from "@/lib/db/schema";
import type { ExtractedTag, ItemKind, QuestionTag } from "@/lib/types";
import { createItemIndex, matchTag, suggestItems, type ItemIndex, type ItemSuggestion } from "@/lib/item-match";

export { normalizeGrammar, type ItemIndex, type ItemSuggestion, type IndexRow } from "@/lib/item-match";

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

/** Free-text library lookup for the MCP `find_items` tool. */
export async function findItems(query: string, opts: { kind?: ItemKind | null; limit?: number } = {}): Promise<ItemSuggestion[]> {
  const index = await loadItemIndex();
  return suggestItems(index, query, { kind: opts.kind ?? null, limit: opts.limit ?? 8 });
}
