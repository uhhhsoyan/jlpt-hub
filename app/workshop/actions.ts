"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sentences } from "@/lib/db/schema";
import { generateSentence } from "@/lib/anthropic";
import type { GeneratedSentence, StudyLevel } from "@/lib/types";
import { errChain, firstLine } from "./db-error";

export type GenerateResult =
  | { ok: true; data: GeneratedSentence }
  | { ok: false; error: string };

export async function generate(englishInput: string): Promise<GenerateResult> {
  const input = englishInput.trim();
  if (!input) return { ok: false, error: "Type something in English first." };
  try {
    return { ok: true, data: await generateSentence(input) };
  } catch (e) {
    return { ok: false, error: humanize(e) };
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/** Saves one study version (by level) of a generation as its own sentence row. */
export async function save(
  englishInput: string,
  data: GeneratedSentence,
  level: StudyLevel,
): Promise<SaveResult> {
  const version = data.versions.find((v) => v.level === level);
  if (!version) return { ok: false, error: `No ${level} version to save.` };
  try {
    await getDb().insert(sentences).values({
      englishInput,
      japanese: version.japanese,
      reading: version.reading,
      gloss: version.gloss,
      levelTag: version.level,
      // withinLevel describes the primary version; a saved N5 sibling of an N4
      // version is a simplification by construction.
      withinLevel: version === data.versions[0] ? data.withinLevel : false,
      faithfulJapanese: data.faithful.japanese,
      faithfulReading: data.faithful.reading,
      faithfulLevelTag: data.faithful.levelTag,
      faithfulDiffers: data.faithful.differs,
      vocab: version.vocab,
      grammar: version.grammar,
      notes: data.notes,
    });
    revalidatePath("/workshop");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanize(e) };
  }
}

// Bound with the row id via `remove.bind(null, id)` in a <form action>.
export async function remove(id: string): Promise<void> {
  try {
    await getDb().delete(sentences).where(eq(sentences.id, id));
    revalidatePath("/workshop");
  } catch {
    // A failed per-row delete just leaves the row; the list reflects true DB state on next render.
  }
}

function humanize(e: unknown): string {
  const msg = errChain(e);
  if (/api[_-]?key|authentication|401/i.test(msg)) {
    return "Claude API key missing or invalid — set ANTHROPIC_API_KEY in .env.local.";
  }
  if (/DATABASE_URL/i.test(msg)) {
    return "Database not configured — set DATABASE_URL in .env.local.";
  }
  if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(msg)) {
    return "Database is connected but the table doesn't exist yet — run `npm run db:push`.";
  }
  return firstLine(msg);
}
