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
  VocabItem,
  GrammarItem,
  JlptLevel,
  ItemKind,
  ItemRelation,
  ItemDetail,
  ObservationSource,
  ObservationKind,
  PracticeSessionStatus,
  PracticeSection,
  QuestionTag,
} from "@/lib/types";

export const sentences = pgTable("sentences", {
  id: uuid("id").defaultRandom().primaryKey(),
  englishInput: text("english_input").notNull(),
  n4Japanese: text("n4_japanese").notNull(),
  n4Reading: text("n4_reading").notNull(),
  n4Gloss: text("n4_gloss").notNull(),
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
    correct: boolean("correct"), // answer only
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
  sourceName: text("source_name"), // e.g. "Shin Nihongo 500 Mon N4-N5"
  status: text("status").$type<PracticeSessionStatus>().notNull().default("review"),
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
