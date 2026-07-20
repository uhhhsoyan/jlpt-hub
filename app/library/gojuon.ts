/**
 * Groups vocab by the gojūon (五十音) row of the first kana in its reading — the same
 * あかさたな... index a paper dictionary uses. Katakana folds to hiragana and
 * dakuten/handakuten variants collapse onto their base row (が→か, ぱ→は, small ゃ→や).
 * Anything that doesn't map to a row (ん, long-vowel mark, stray romaji, etc.) lands in
 * a final catch-all bucket keyed "ん".
 */

export const GOJUON_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "ん"] as const;
export type GojuonRow = (typeof GOJUON_ROWS)[number];

const ROW_BY_KANA: Record<string, GojuonRow> = {
  あ: "あ", い: "あ", う: "あ", え: "あ", お: "あ",
  ぁ: "あ", ぃ: "あ", ぅ: "あ", ぇ: "あ", ぉ: "あ", ゔ: "あ",
  か: "か", き: "か", く: "か", け: "か", こ: "か",
  が: "か", ぎ: "か", ぐ: "か", げ: "か", ご: "か", ゕ: "か", ゖ: "か",
  さ: "さ", し: "さ", す: "さ", せ: "さ", そ: "さ",
  ざ: "さ", じ: "さ", ず: "さ", ぜ: "さ", ぞ: "さ",
  た: "た", ち: "た", つ: "た", て: "た", と: "た",
  だ: "た", ぢ: "た", づ: "た", で: "た", ど: "た", っ: "た",
  な: "な", に: "な", ぬ: "な", ね: "な", の: "な",
  は: "は", ひ: "は", ふ: "は", へ: "は", ほ: "は",
  ば: "は", び: "は", ぶ: "は", べ: "は", ぼ: "は",
  ぱ: "は", ぴ: "は", ぷ: "は", ぺ: "は", ぽ: "は",
  ま: "ま", み: "ま", む: "ま", め: "ま", も: "ま",
  や: "や", ゆ: "や", よ: "や", ゃ: "や", ゅ: "や", ょ: "や",
  ら: "ら", り: "ら", る: "ら", れ: "ら", ろ: "ら",
  わ: "わ", ゐ: "わ", ゑ: "わ", を: "わ", ゎ: "わ",
  ん: "ん",
};

/** Katakana U+30A1–U+30F6 sits exactly 0x60 above its hiragana counterpart. */
function toHiragana(ch: string): string {
  const code = ch.codePointAt(0);
  if (code === undefined) return ch;
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCodePoint(code - 0x60);
  return ch;
}

export function gojuonRowOf(reading: string): GojuonRow {
  const first = reading.trim().charAt(0);
  if (!first) return "ん";
  return ROW_BY_KANA[toHiragana(first)] ?? "ん";
}

export interface GojuonGroup<T> {
  row: GojuonRow;
  items: T[];
}

/** Buckets items (already sorted by reading) into gojūon rows, dropping empty rows. */
export function groupByGojuon<T extends { reading: string }>(items: T[]): GojuonGroup<T>[] {
  const buckets = new Map<GojuonRow, T[]>(GOJUON_ROWS.map((row) => [row, []]));
  for (const item of items) {
    buckets.get(gojuonRowOf(item.reading))!.push(item);
  }
  return GOJUON_ROWS.map((row) => ({ row, items: buckets.get(row)! })).filter((g) => g.items.length > 0);
}
