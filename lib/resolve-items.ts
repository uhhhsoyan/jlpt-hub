import { getDb } from "@/lib/db";
import { items } from "@/lib/db/schema";
import type { ExtractedTag, QuestionTag } from "@/lib/types";

/** Pure kana (hiragana + katakana, incl. the prolonged-sound mark) — used to try a reading match for vocab tags. */
const KANA_ONLY = /^[぀-ゟ゠-ヿ]+$/u;

/**
 * Loosen a grammar pattern for matching: drop a trailing parenthetical disambiguator
 * ("に (time)" -> "に"), strip any leading/trailing tilde variant (〜/～/~), and outer
 * whitespace. Mirrors scripts/backfill-workshop.mjs's normalizePattern exactly, so both
 * paths agree on what "the same grammar point" means.
 */
function normalizeGrammar(s: string): string {
  return s
    .replace(/[（(][^（()）]*[)）]\s*$/u, "")
    .replace(/^[\s〜～~]+/u, "")
    .replace(/[\s〜～~]+$/u, "");
}

interface CandidateRow {
  id: string;
  kind: string;
  headword: string;
  reading: string;
}

/** key -> ids sharing that key; only a single id means an unambiguous match. */
function groupIds(rows: CandidateRow[], keyFn: (r: CandidateRow) => string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(row.id);
    else map.set(key, [row.id]);
  }
  return map;
}

function uniqueId(ids: string[] | undefined): string | null {
  return ids && ids.length === 1 ? ids[0] : null;
}

/**
 * Resolve extracted tags against the `items` table. One DB round-trip loading every
 * candidate row (items is small — a few thousand rows at most), then matching in JS:
 * - vocab: exact headword match (unique only); for kana-only tag text, also try matching
 *   against reading (unique only).
 * - kanji: exact headword match (headword is always a single character for kanji rows).
 * - grammar: exact headword match, then a normalized match (unique only in both cases).
 * Order is preserved 1:1 with the input so callers can re-slice per question.
 */
export async function resolveTags(tags: ExtractedTag[]): Promise<QuestionTag[]> {
  if (tags.length === 0) return [];

  const rows = await getDb()
    .select({
      id: items.id,
      kind: items.kind,
      headword: items.headword,
      reading: items.reading,
    })
    .from(items);

  const vocabRows = rows.filter((r) => r.kind === "vocab");
  const kanjiRows = rows.filter((r) => r.kind === "kanji");
  const grammarRows = rows.filter((r) => r.kind === "grammar");

  const vocabByHeadword = groupIds(vocabRows, (r) => r.headword);
  const vocabByReading = groupIds(vocabRows, (r) => r.reading);
  const kanjiByHeadword = groupIds(kanjiRows, (r) => r.headword);
  const grammarByHeadword = groupIds(grammarRows, (r) => r.headword);
  const grammarByNormalized = groupIds(grammarRows, (r) => normalizeGrammar(r.headword));

  return tags.map((tag) => {
    const text = tag.text.trim();
    let itemId: string | null = null;

    if (tag.kind === "vocab") {
      itemId = uniqueId(vocabByHeadword.get(text));
      if (!itemId && KANA_ONLY.test(text)) {
        itemId = uniqueId(vocabByReading.get(text));
      }
    } else if (tag.kind === "kanji") {
      itemId = uniqueId(kanjiByHeadword.get(text));
    } else if (tag.kind === "grammar") {
      itemId = uniqueId(grammarByHeadword.get(text));
      if (!itemId) {
        itemId = uniqueId(grammarByNormalized.get(normalizeGrammar(text)));
      }
    }

    return { kind: tag.kind, text: tag.text, itemId };
  });
}
