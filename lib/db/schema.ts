import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  uniqueIndex,
  index,
  integer,
} from "drizzle-orm/pg-core";
import type {
  VocabQueueStatus,
  VocabSighting,
  VocabItem,
  GrammarItem,
  JlptLevel,
  StudyLevel,
  IntegrationSource,
  ItemKind,
  ItemRelation,
  ItemDetail,
  ObservationSource,
  ObservationKind,
  PracticeSessionStatus,
  PracticeSection,
  PracticeSurface,
  QuestionTag,
  InsightSource,
  SessionMode,
  StudySourceKind,
  StudyActivity,
} from "@/lib/types";

// One saved study sentence at one level (N5 or N4). A single workshop generation can
// produce both an N4 and an N5 rendition; saving both creates two rows. The n4_*
// column names are historical (pre-JLPT-Hub, when every sentence was an "N4 version")
// and are kept so the deployed app keeps working across the migration.
export const sentences = pgTable("sentences", {
  id: uuid("id").defaultRandom().primaryKey(),
  englishInput: text("english_input").notNull(),
  japanese: text("n4_japanese").notNull(),
  reading: text("n4_reading").notNull(),
  gloss: text("n4_gloss").notNull(),
  levelTag: text("level_tag").$type<StudyLevel>().notNull().default("N4"),
  withinLevel: boolean("within_level").notNull(),
  faithfulJapanese: text("faithful_japanese").notNull(),
  faithfulReading: text("faithful_reading").notNull(),
  faithfulLevelTag: text("faithful_level_tag").$type<JlptLevel>().notNull(),
  faithfulDiffers: boolean("faithful_differs").notNull(),
  vocab: jsonb("vocab").$type<VocabItem[]>().notNull(),
  grammar: jsonb("grammar").$type<GrammarItem[]>().notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SentenceRow = typeof sentences.$inferSelect;

// Listening clips mined from YouTube: Japanese text paired with a real audio slice.
export const clips = pgTable("clips", {
  id: uuid("id").defaultRandom().primaryKey(),
  japanese: text("japanese").notNull(),
  audioUrl: text("audio_url").notNull(), // served from /public/mined/...
  sourceUrl: text("source_url").notNull(), // deep link back to the video timestamp
  sourceLabel: text("source_label"), // video title
  startSec: doublePrecision("start_sec").notNull(),
  endSec: doublePrecision("end_sec").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ClipRow = typeof clips.$inferSelect;

// Canonical JLPT study items (vocab / kanji / grammar) — the knowledge-graph node set.
// Seeded from data/seed/*.json via `npm run db:seed`. Single-user app: no userId columns
// anywhere yet; adding multi-user support would be a schema migration across the board.
export const items = pgTable(
  "items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").$type<ItemKind>().notNull(),
    // Lowest JLPT level at which the item is required (the N4 source list is cumulative).
    level: text("level").$type<JlptLevel>().notNull(),
    headword: text("headword").notNull(), // 会う / 安 / 〜てもいい
    // Kana reading; empty string (not null) for grammar so the identity index stays simple.
    reading: text("reading").notNull().default(""),
    romaji: text("romaji"),
    meaning: text("meaning").notNull(),
    detail: jsonb("detail").$type<ItemDetail>(),
    // Alternate spellings a logging surface might use for this item ("ほど〜ない", "のほう",
    // "いちばん"); lib/resolve-items.ts matches tags against these after the headword.
    aliases: jsonb("aliases").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("items_identity").on(t.kind, t.headword, t.reading),
    index("items_kind_level").on(t.kind, t.level),
  ],
);

export type ItemRow = typeof items.$inferSelect;

export const itemEdges = pgTable(
  "item_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromId: uuid("from_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    toId: uuid("to_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    relation: text("relation").$type<ItemRelation>().notNull(),
  },
  (t) => [
    uniqueIndex("item_edges_identity").on(t.fromId, t.toId, t.relation),
    index("item_edges_to").on(t.toId),
  ],
);

export type ItemEdgeRow = typeof itemEdges.$inferSelect;

// Append-only evidence ledger: every study signal attaches to an item. Mastery is
// computed at read time from this table (see lib/mastery.ts) — no materialized score.
export const observations = pgTable(
  "observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    source: text("source").$type<ObservationSource>().notNull(),
    kind: text("kind").$type<ObservationKind>().notNull(),
    correct: boolean("correct"), // answer, and exposure when the open-book answer was graded
    srsStage: integer("srs_stage"), // srs_state only (WaniKani stages 0–9)
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("observations_item").on(t.itemId, t.occurredAt),
    index("observations_source").on(t.source, t.kind),
  ],
);

export type ObservationRow = typeof observations.$inferSelect;

// One uploaded batch of completed practice-book / past-exam pages. Questions are staged
// in `review` status for a human confirm/edit pass; observations are written only when
// the session is confirmed (bad evidence is worse than a 10-second review step).
export const practiceSessions = pgTable("practice_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: text("label").notNull(), // e.g. "500問 Week 2 Day 3"
  // Catalog entry the page came from (study_sources); null for sessions that name no
  // source or whose source_name matched nothing. source_name stays as free text for the
  // detail (chapter, lesson, page) and for pre-catalog sessions.
  sourceId: uuid("source_id").references(() => studySources.id, { onDelete: "set null" }),
  sourceName: text("source_name"), // e.g. "Shin Nihongo 500 Mon N4-N5", "実力養成編 第1部 2課"
  status: text("status").$type<PracticeSessionStatus>().notNull().default("review"),
  // Which surface wrote the session: the Hub photo flow, an MCP client, or the CSV import.
  surface: text("surface").$type<PracticeSurface>().notNull().default("hub"),
  // practice (closed book: counts toward accuracy) or lesson (open book: exposure only).
  mode: text("mode").$type<SessionMode>().notNull().default("practice"),
  // Whether the page was done under exam timing; null when unknown (older sessions).
  timed: boolean("timed"),
  imagePaths: jsonb("image_paths").$type<string[]>().notNull(),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PracticeSessionRow = typeof practiceSessions.$inferSelect;

export const practiceQuestions = pgTable(
  "practice_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => practiceSessions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(), // order within the session
    section: text("section").$type<PracticeSection>().notNull(),
    stem: text("stem").notNull(),
    choices: jsonb("choices").$type<string[]>().notNull(),
    correctChoice: integer("correct_choice"), // index into choices; null if unknown
    userChoice: integer("user_choice"), // null if the mark couldn't be read
    isCorrect: boolean("is_correct"), // null until both choices are known
    explanation: text("explanation"),
    tags: jsonb("tags").$type<QuestionTag[]>().notNull(),
    // Exam level the question targets, when known (the 500問 book mixes N5 and N4).
    level: text("level").$type<StudyLevel>(),
    // Why it was missed — null for correct answers and for misses not yet classified.
    // Open vocabulary: ROOT_CAUSES in lib/types.ts is the preferred set, anything else is
    // kept verbatim (normalized to kebab-case) and reported under its own label.
    rootCause: text("root_cause"),
    // Free-text diagnosis from the review ("picked つもり, needed はず — confused certainty").
    note: text("note"),
    // Sink for structured facts with no column of their own (e.g. sectionRaw when the
    // section word wasn't recognised, or anything a logging surface wants to keep).
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("practice_questions_session").on(t.sessionId, t.number)],
);

export type PracticeQuestionRow = typeof practiceQuestions.$inferSelect;

// Resolved question→item links (the graph edges practice evidence flows through).
export const questionItems = pgTable(
  "question_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => practiceQuestions.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    role: text("role").$type<"tested" | "context">().notNull(),
  },
  (t) => [uniqueIndex("question_items_identity").on(t.questionId, t.itemId)],
);

export type QuestionItemRow = typeof questionItems.$inferSelect;

// Vocab-sprint sentences: one level-validated example sentence per vocab item, in
// frequency-ish order (verbs first, N5 before N4), grouped into decks ("chunks") of 100.
// Generated by scripts/generate-sprint.mjs; audio added by scripts/tts-sprint.mjs.
export const sprintSentences = pgTable(
  "sprint_sentences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    japanese: text("japanese").notNull(),
    reading: text("reading").notNull(), // all-kana; also what we feed the TTS
    english: text("english").notNull(),
    audioPath: text("audio_path"), // /sprint/<id>.mp3, local-only like mined clips
    chunk: integer("chunk").notNull(), // 0-based deck of 100
    position: integer("position").notNull(), // order within the chunk
    // True when the tokenizer confirmed every content lemma is on the N5/N4 list and
    // the target word actually appears; false rows survived retries with violations.
    validated: boolean("validated").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("sprint_sentences_item").on(t.itemId), index("sprint_sentences_chunk").on(t.chunk, t.position)],
);

export type SprintSentenceRow = typeof sprintSentences.$inferSelect;

// Per-deck listening progress (recall accuracy lives in observations, source='sprint').
export const sprintChunks = pgTable("sprint_chunks", {
  chunk: integer("chunk").primaryKey(),
  listenCount: integer("listen_count").notNull().default(0),
  lastListenedAt: timestamp("last_listened_at", { withTimezone: true }),
});

export type SprintChunkRow = typeof sprintChunks.$inferSelect;

// Singleton (id = 1): the user's WaniKani level state as of the last sync. Drives the
// schedule's level tracking; see WkLevelSnapshot in lib/types.ts for field semantics.
export const wkSnapshot = pgTable("wk_snapshot", {
  id: integer("id").primaryKey(),
  level: integer("level").notNull(),
  kanjiPassed: integer("kanji_passed").notNull(),
  kanjiTotal: integer("kanji_total").notNull(),
  kanjiRequired: integer("kanji_required").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  // Lease for the visit-triggered background sync: set when a request claims the
  // right to sync (see syncWanikaniIfStale), so concurrent page loads don't all
  // pull WaniKani at once. Expires on its own; success updates synced_at.
  syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
});

export type WkSnapshotRow = typeof wkSnapshot.$inferSelect;

// Singleton (id = 1): state of the last Bunpro sync, mirroring wk_snapshot. Doubles
// as the staleness lease for the visit-triggered background sync (sync_started_at).
export const bpSnapshot = pgTable("bp_snapshot", {
  id: integer("id").primaryKey(),
  reviewsSeen: integer("reviews_seen").notNull(),
  itemsMapped: integer("items_mapped").notNull(),
  observationsWritten: integer("observations_written").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
});

export type BpSnapshotRow = typeof bpSnapshot.$inferSelect;

// Per-integration kill switch. No row = enabled (integrations are opt-in via their
// env keys anyway); a row with enabled=false stops every sync path (cron, visit-
// triggered, manual button) without touching already-recorded evidence. Pair with
// the purge action to fully remove an integration's contribution.
export const integrationSettings = pgTable("integration_settings", {
  source: text("source").$type<IntegrationSource>().primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type IntegrationSettingsRow = typeof integrationSettings.$inferSelect;

// Narrative study notes: recurring patterns and beliefs that don't attach to one item
// ("confuses どっち/どう under time pressure"). Written by the MCP log_insight tool and
// read back by get_insights; the relational ledger above stays the ground truth, this is
// the lightweight stand-in for a memory system.
export const insights = pgTable(
  "insights",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    text: text("text").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // Optional links into the item graph, when the note is about specific items.
    itemIds: jsonb("item_ids").$type<string[]>().notNull().default([]),
    // The raw item tags as logged, with itemId null where nothing matched, so a later
    // relink (new items, new aliases) can attach them without the note being re-logged.
    items: jsonb("items").$type<QuestionTag[]>().notNull().default([]),
    source: text("source").$type<InsightSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("insights_created").on(t.createdAt)],
);

export type InsightRow = typeof insights.$inferSelect;

// The catalog of things the learner studies from: textbooks, workbooks, question banks,
// the official JLPT workbooks, and apps. Seeded from data/seed/study-sources.json
// (`npm run db:seed-sources`, upsert on slug) and editable in the Hub at /sources. Never
// deleted: `active=false` hides a source from the grid and the practice form while every
// session and study-log row that points at it keeps resolving.
export const studySources = pgTable("study_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(), // stable id used by the MCP tools and URLs
  name: text("name").notNull(), // English display name
  nameJa: text("name_ja"), // Japanese title, when the source has one
  kind: text("kind").$type<StudySourceKind>().notNull(),
  level: text("level"), // "N4", "N5", "N4-N5"; null for level-agnostic apps
  edition: text("edition"), // "3rd edition, The Japan Times"
  url: text("url"),
  imageUrl: text("image_url"), // Blob URL or pasted URL; null = /public/sources/<slug>.* or the placeholder card
  color: text("color"), // hex, for the typographic placeholder card
  // Alternate names a logging surface might use ("SKM N4 文法", "Genki II"); see
  // resolveSource in lib/study-sources.ts for how they are matched.
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  description: text("description"), // what it is, one line
  howUsed: text("how_used"), // how it fits the study plan, so a logging agent knows which mode/tool to use
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type StudySourceRow = typeof studySources.$inferSelect;

// Time-based study with no graded questions: 30 minutes in Satori Reader, a WaniKani
// review session, a listening pass. Written by the MCP log_study tool. Evidence-free on
// purpose: it says what was done with which source, not what was learned; item-level
// signals for apps still arrive through their own syncs (WaniKani, Bunpro).
export const studyLog = pgTable(
  "study_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").references(() => studySources.id, { onDelete: "set null" }),
    activity: text("activity").$type<StudyActivity>().notNull(),
    minutes: integer("minutes"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    note: text("note"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    surface: text("surface").$type<PracticeSurface>().notNull().default("claude-ai"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("study_log_source").on(t.sourceId, t.takenAt)],
);

export type StudyLogRow = typeof studyLog.$inferSelect;

// Words the learner did not know, wherever they came up (a `vocab_gaps` entry on a logged
// attempt, the `queue_vocab` tool, the Hub). One row per NFKC-normalised word; repeats bump
// seen_count and append a sighting. Reviewed by hand at /queue and exported to Anki; status
// is the learner's decision (carded / skipped / known), never inferred. See lib/vocab-queue.ts.
export const vocabQueue = pgTable(
  "vocab_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    norm: text("norm").notNull().unique(),
    text: text("text").notNull(),
    reading: text("reading"),
    meaning: text("meaning"),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    status: text("status").$type<VocabQueueStatus>().notNull().default("queued"),
    seenCount: integer("seen_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    sightings: jsonb("sightings").$type<VocabSighting[]>().notNull().default([]),
    surface: text("surface").$type<PracticeSurface>().notNull().default("claude-ai"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("vocab_queue_status").on(t.status, t.lastSeenAt)],
);

export type VocabQueueRow = typeof vocabQueue.$inferSelect;
