import { pgTable, uuid, text, boolean, jsonb, timestamp, doublePrecision } from "drizzle-orm/pg-core";
import type { VocabItem, GrammarItem, JlptLevel } from "@/lib/types";

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
