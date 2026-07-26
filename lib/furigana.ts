/**
 * Aligns a sentence's stored all-kana reading against its kanji runs so the UI can
 * render real <ruby> furigana without any extra data or AI calls.
 *
 * How: split the sentence into kanji runs and literal runs (kana, punctuation, romaji).
 * Literal runs must appear verbatim in the reading and act as anchors; the kana between
 * anchors is the reading of the kanji run there. Anchors alone can be ambiguous — in
 * 十二月に日本へ the particle に also occurs inside じゅうにがつ — so all alignments are
 * scored and the one whose kanji readings have the most plausible length (~2 kana per
 * character) wins. Returns null when nothing lines up (caller falls back to showing the
 * reading under the sentence).
 */

export interface FuriganaSegment {
  text: string;
  /** Kana annotation for this segment; absent for text that needs no furigana. */
  ruby?: string;
}

// Han ideographs plus the repetition/counter marks that take readings like kanji do.
const HAN = /^[\p{Script=Han}々〆ヵヶ]$/u;
// Digits are also read as kana (１２月 → じゅうにがつ), so they take ruby too.
const ANNOTATABLE = /^[\p{Script=Han}々〆ヵヶ0-9０-９]$/u;
const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]$/u;

interface Run {
  text: string;
  isKanji: boolean;
  /** Code-point length, used to judge how plausible a candidate reading's length is. */
  length: number;
  /** Han characters need at least one kana each; digits don't (1000 → せん). */
  minKana: number;
}

interface Path {
  cost: number;
  /** Reading (as code-point slice bounds) per remaining kanji run, front to back. */
  rubies: string[];
}

export function alignFurigana(japanese: string, reading: string): FuriganaSegment[] | null {
  if (!japanese) return null;

  const runs: Run[] = [];
  for (const ch of japanese) {
    const isKanji = ANNOTATABLE.test(ch);
    const minKana = HAN.test(ch) ? 1 : 0;
    const last = runs[runs.length - 1];
    if (last && last.isKanji === isKanji) {
      last.text += ch;
      last.length++;
      last.minKana += minKana;
    } else {
      runs.push({ text: ch, isKanji, length: 1, minKana });
    }
  }

  if (!runs.some((r) => r.isKanji)) {
    // Nothing to annotate — the sentence is already fully readable kana/latin.
    return [{ text: japanese }];
  }

  const kana = Array.from(reading.trim());
  if (kana.length === 0) return null;

  // Cheapest alignment of runs[i..] against kana[pos..]; null when impossible.
  const memo = new Map<number, Path | null>();
  const best = (i: number, pos: number): Path | null => {
    if (i === runs.length) return pos === kana.length ? { cost: 0, rubies: [] } : null;
    const key = i * (kana.length + 1) + pos;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const run = runs[i];
    let result: Path | null = null;

    if (!run.isKanji) {
      const anchor = Array.from(run.text);
      const matches = anchor.every((ch, j) => kana[pos + j] === ch);
      result = matches ? best(i + 1, pos + anchor.length) : null;
    } else {
      for (let take = Math.max(1, run.minKana); pos + take <= kana.length; take++) {
        const slice = kana.slice(pos, pos + take);
        if (!slice.every((ch) => KANA.test(ch))) break;
        const rest = best(i + 1, pos + take);
        if (!rest) continue;
        // Kanji readings run ~1-2 kana per character; penalize implausible lengths.
        const cost = Math.abs(take / run.length - 1.5) + rest.cost;
        if (!result || cost < result.cost) {
          result = { cost, rubies: [slice.join(""), ...rest.rubies] };
        }
      }
    }

    memo.set(key, result);
    return result;
  };

  const path = best(0, 0);
  if (!path) return null;

  let ruby = 0;
  return runs.map((r) => (r.isKanji ? { text: r.text, ruby: path.rubies[ruby++] } : { text: r.text }));
}
