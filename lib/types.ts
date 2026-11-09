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
  /** Set by the Bunpro sync once a grammar point is mapped to this item. */
  bpGrammarPointId?: number;
  /** Genki (3rd edition) chapter reference, e.g. "L12"; written by the ledger import. */
  genkiRef?: string | null;
  /** Coverage flag from the ledger, e.g. "NOT-IN-GENKI". */
  genkiCoverage?: string | null;
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
export type ObservationSource =
  | "wanikani"
  | "bunpro"
  | "practice"
  | "workshop"
  | "sprint"
  | "anki"
  | "manual";

/** External services that sync evidence in; each can be disabled and purged independently. */
export type IntegrationSource = "wanikani" | "bunpro";
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

/**
 * Why a practice question was missed. The heart of the study ledger: accuracy by item
 * says *what* is weak, root cause says *why*, which is what decides the next week's drills.
 * Distilled from ~150 logged Shin Nihongo 500 Mon questions (Oct 2026).
 */
export const ROOT_CAUSES = [
  "grammar-unknown",
  "vocab-in-grammar",
  "vocab-unknown",
  "vocab-confusion",
  "reading-selection",
  "particle-cue-missed",
  "pattern-glue",
  "misparse",
  "careless",
  "time-pressure",
  "context-cue-missed",
  "distractor-bias",
  "kanji-lookalike",
  "katakana-decoding",
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  "grammar-unknown": "Grammar unknown",
  "vocab-in-grammar": "Vocab inside grammar",
  "vocab-unknown": "Vocab unknown",
  "vocab-confusion": "Vocab confusion",
  "reading-selection": "Reading selection",
  "particle-cue-missed": "Particle cue missed",
  "pattern-glue": "Pattern glue",
  misparse: "Misparse",
  careless: "Careless",
  "time-pressure": "Time pressure",
  "context-cue-missed": "Context cue missed",
  "distractor-bias": "Distractor bias",
  "kanji-lookalike": "Kanji lookalike",
  "katakana-decoding": "Katakana decoding",
};

export function isKnownRootCause(cause: string): cause is RootCause {
  return (ROOT_CAUSES as readonly string[]).includes(cause);
}

/**
 * Root causes are an open vocabulary: the list above is the preferred set, but anything
 * short and kebab-case is stored as given so new categories can show up in the data before
 * they are promoted to the list. This only tidies spelling ("Careless", "time pressure").
 */
export function normalizeRootCause(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return v.length > 0 ? v : null;
}

export function rootCauseLabel(cause: string): string {
  return isKnownRootCause(cause) ? ROOT_CAUSE_LABEL[cause] : cause;
}

/** Where a practice session was logged from. `hub` is the photo-upload flow; the rest write through the MCP tools or the CSV import. */
export type PracticeSurface = "hub" | "claude-ai" | "claude-code" | "import";

/** Free-form study notes (patterns, beliefs, "confuses どっち/どう under time pressure"). */
export type InsightSource = PracticeSurface;

/**
 * What a session's answers are evidence of. `practice` is closed-book work (500問 pages,
 * mock tests, chat drills): answers feed accuracy, the weak list and root-cause reports.
 * `lesson` is open-book work right after reading the explanation (textbook example
 * sentences, れんしゅう with the notes in view): it proves exposure, not ability, so its
 * answers are recorded as `exposure` observations and left out of every accuracy figure.
 */
export const SESSION_MODES = ["practice", "lesson"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/**
 * Study sources: the books, question banks, official workbooks and apps the learner
 * studies from (docs/plans/08-study-sources.md). A practice session can point at one, and
 * time-based activity with no graded questions is logged against one in `study_log`.
 */
export const STUDY_SOURCE_KINDS = ["textbook", "workbook", "question-bank", "official-test", "app", "reader"] as const;
export type StudySourceKind = (typeof STUDY_SOURCE_KINDS)[number];

export const STUDY_SOURCE_KIND_LABEL: Record<StudySourceKind, string> = {
  textbook: "Textbook",
  workbook: "Workbook",
  "question-bank": "Question bank",
  "official-test": "Official test",
  app: "App",
  reader: "Reader",
};

/** What a study-log entry records: activity that produced no graded answers. */
export const STUDY_ACTIVITIES = ["reading", "listening", "review", "lesson", "drill", "other"] as const;
export type StudyActivity = (typeof STUDY_ACTIVITIES)[number];

export const STUDY_ACTIVITY_LABEL: Record<StudyActivity, string> = {
  reading: "Reading",
  listening: "Listening",
  review: "Review",
  lesson: "Lesson",
  drill: "Drill",
  other: "Other",
};

/**
 * Vocab queue: words the learner did not know or had to look up, wherever they came up
 * (graded questions, lessons, reading, chat). Reviewed by hand at /queue and exported to
 * Anki. `known` = already in a deck or genuinely known; `skipped` = not worth a card.
 */
export const VOCAB_QUEUE_STATUSES = ["queued", "carded", "skipped", "known"] as const;
export type VocabQueueStatus = (typeof VOCAB_QUEUE_STATUSES)[number];
export const VOCAB_QUEUE_STATUS_LABEL: Record<VocabQueueStatus, string> = {
  queued: "Queued",
  carded: "Carded",
  skipped: "Skipped",
  known: "Known",
};
export function isVocabQueueStatus(v: string): v is VocabQueueStatus {
  return (VOCAB_QUEUE_STATUSES as readonly string[]).includes(v);
}

/** One time a queued word was met; kept on the row so repeats accumulate instead of duplicating. */
export interface VocabSighting {
  /** ISO date/time of the session or sighting. */
  at: string;
  /** The phrase or sentence it stalled in, or the note on the question. */
  context: string | null;
  sessionId: string | null;
  questionId: string | null;
  /** Session label or free text ("SKM N4 L6 れんしゅう1", "Satori Reader"). */
  label: string | null;
}
