import type { JlptLevel, PartOfSpeech } from "@/lib/types";

/** The only two item kinds this page shows (grammar isn't part of the library view). */
export type LibraryKind = "vocab" | "kanji";

/**
 * Lean, client-safe projection of an `items` row: just what the library view renders.
 * Built server-side in page.tsx so we never ship the jsonb `detail` blob or `createdAt`
 * to the client wholesale.
 */
export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  level: JlptLevel;
  headword: string;
  /** Kana reading; always "" for kanji rows. */
  reading: string;
  romaji: string | null;
  meaning: string;
  /** Vocab only, from detail.pos. */
  pos: PartOfSpeech | null;
  /** Kanji only, from detail.onyomi / detail.kunyomi. */
  onyomi: string | null;
  kunyomi: string | null;
}
