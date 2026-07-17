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

/** The structured object Claude returns for one English input. */
export interface GeneratedSentence {
  /** A version rewritten to stay within JLPT N4 (which includes all N5). */
  n4: {
    japanese: string;
    /** Full hiragana reading of the N4 sentence (no kanji). */
    reading: string;
    /** Literal English of the N4 version, so the learner sees what the simpler Japanese says. */
    gloss: string;
  };
  /** True if the N4 version fully captures the input using only N4-level language. */
  withinLevel: boolean;
  /** The most natural Japanese that faithfully expresses the original English, even if it exceeds N4. */
  faithful: {
    japanese: string;
    reading: string;
    /** Approximate highest JLPT level of grammar/vocab used (model's best estimate). */
    levelTag: JlptLevel;
    /** True when this meaningfully differs from the N4 version. */
    differsFromN4: boolean;
  };
  /** Content words in the N4 sentence, with level tags. */
  vocab: VocabItem[];
  /** Grammar patterns in the N4 sentence, with level tags. */
  grammar: GrammarItem[];
  /** 1-3 sentence plain-English note on what was simplified / what the faithful version needs. */
  notes: string;
}
