import type { JlptLevel } from "@/lib/types";

/** One sprint sentence joined to its vocab item, ordered within a deck. */
export interface SprintRow {
  id: string;
  japanese: string;
  reading: string;
  english: string;
  audioPath: string | null;
  position: number;
  itemId: string;
  headword: string;
  itemReading: string;
  meaning: string;
  level: JlptLevel;
}
