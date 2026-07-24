export type JlptLevel = "N5" | "N4" | "N3" | "N2" | "N1";
export type VocabLevel = JlptLevel | "other";

export interface VocabItem {
  word: string;
  reading: string;
  meaning: string;
  level: VocabLevel;
}

export interface GrammarItem {
  pattern: string;
  level: JlptLevel;
  note: string;
}

/** Canonical study-item node: one row per N5/N4 vocab word, kanji, or grammar point. */
export type ItemKind = "vocab" | "kanji" | "grammar";

export type ItemRelation = "contains_kanji" | "related" | "prerequisite";

export type PartOfSpeech = "verb" | "i-adjective" | "na-adjective";

export interface ItemDetail {
  /** Vocab only; from the source's POS lists where available. */
  pos?: PartOfSpeech | null;
  /** Kanji only. */
  onyomi?: string | null;
  kunyomi?: string | null;
  unicode?: string;
  /** Grammar only: one curated example sentence. */
  example?: string;
  exampleReading?: string;
  exampleEnglish?: string;
  /** Set by the WaniKani sync once a subject is mapped to this item. */
  wkSubjectId?: number;
}

/**
 * Snapshot of WaniKani level state, written on every sync (wk_snapshot singleton row).
 * Level-up happens when 90% of the current level's kanji reach guru (srs_stage >= 5).
 */
export interface WkLevelSnapshot {
  level: number;
  kanjiPassed: number;
  kanjiTotal: number;
  /** ceil(0.9 * kanjiTotal) — WaniKani's level-up bar. */
  kanjiRequired: number;
  /** ISO timestamp (string so it serializes cleanly to client components). */
  syncedAt: string;
}

/** Evidence ledger: where a study signal came from and what it says. */
export type ObservationSource = "wanikani" | "practice" | "workshop" | "sprint" | "anki" | "manual";
export type ObservationKind = "answer" | "srs_state" | "exposure";

export type MasteryStatus = "unseen" | "learning" | "solid" | "mastered";

/** Practice sessions: photos of completed workbook/exam pages, extracted and graded. */
export type PracticeSessionStatus = "review" | "confirmed";
export type PracticeSection = "kanji" | "vocab" | "grammar" | "reading" | "listening" | "other";

/** A raw item tag proposed by extraction; itemId is set once resolved against `items`. */
export interface QuestionTag {
  kind: ItemKind;
  text: string;
  itemId: string | null;
}

/** A tag as proposed by extraction, before resolution against the items table. */
export interface ExtractedTag {
  kind: ItemKind;
  text: string;
}

/** One question as read off a photographed practice page, before item-tag resolution. */
export interface ExtractedQuestion {
  number: number;
  section: PracticeSection;
  stem: string;
  choices: string[];
  /** Index into choices; null if the answer key wasn't visible/legible. */
  correctChoice: number | null;
  /** Index into choices; null if the learner's mark wasn't visible/legible. */
  userChoice: number | null;
  explanation: string;
  tags: ExtractedTag[];
}

/** Levels the learner is actively studying; every saved sentence is tagged with one. */
export type StudyLevel = "N5" | "N4";

/** One study rendition of the input, kept within its tagged JLPT level. */
export interface SentenceVersion {
  /** Highest JLPT level the version uses: "N5" when it's pure N5, else "N4". */
  level: StudyLevel;
  japanese: string;
  /** Full kana reading of the sentence (no kanji). */
  reading: string;
  /** Literal English of THIS version, so the learner sees what the simpler Japanese says. */
  gloss: string;
  /** Content words in this version, with level tags. */
  vocab: VocabItem[];
  /** Grammar patterns in this version, with level tags. */
  grammar: GrammarItem[];
}

/** The structured object Claude returns for one English input. */
export interface GeneratedSentence {
  /**
   * Study versions of the input. One entry when the faithful translation already fits
   * within N4 (tagged with the level it actually uses); two entries — N4 first, then a
   * simpler N5 rendition — when the faithful translation needs grammar/vocab above N4.
   */
  versions: SentenceVersion[];
  /** True if versions[0] fully captures the input's meaning and nuance. */
  withinLevel: boolean;
  /** The most natural Japanese that faithfully expresses the original English, whatever its level. */
  faithful: {
    japanese: string;
    reading: string;
    /** Approximate highest JLPT level of grammar/vocab used (model's best estimate). */
    levelTag: JlptLevel;
    /** True when this meaningfully differs from versions[0]. */
    differs: boolean;
  };
  /** 1-3 sentence plain-English note on levels used / what was simplified. */
  notes: string;
}
