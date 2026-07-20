"use server";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { practiceSessions, practiceQuestions, questionItems, observations } from "@/lib/db/schema";
import { extractQuestions, type PracticeImage } from "@/lib/practice-extract";
import { resolveTags } from "@/lib/resolve-items";
import { deleteStoredFiles, storeFile } from "@/lib/storage";
import type { QuestionTag } from "@/lib/types";
import { errChain, firstLine } from "@/app/workshop/db-error";

const MAX_IMAGES = 8;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type CreateSessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

/**
 * NOTE: with BLOB_READ_WRITE_TOKEN set, images are uploaded to Vercel Blob and this
 * feature works when deployed. Without it, images fall back to public/practice/<sessionId>/
 * like before — fine for local use, but public/ writes don't survive a Vercel deploy (the
 * filesystem is read-only/ephemeral there). See lib/storage.ts.
 */
export async function createSession(formData: FormData): Promise<CreateSessionResult> {
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return { ok: false, error: "Give this session a label." };

  const sourceNameRaw = String(formData.get("sourceName") ?? "").trim();
  const sourceName = sourceNameRaw || null;

  const takenAtRaw = String(formData.get("takenAt") ?? "").trim();
  const takenAt = takenAtRaw ? new Date(takenAtRaw) : new Date();
  if (Number.isNaN(takenAt.getTime())) {
    return { ok: false, error: "That date doesn't look right." };
  }

  const files = formData.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: false, error: "Add at least one photo." };
  if (files.length > MAX_IMAGES) return { ok: false, error: `Add at most ${MAX_IMAGES} photos.` };

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return { ok: false, error: "Those photos are too large together — keep it under 20MB total." };
  }

  const heic = files.find((f) => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name));
  if (heic) {
    return {
      ok: false,
      error:
        "HEIC photos aren't supported — Claude can't read them. Convert to JPEG or PNG first (on iPhone: Settings > Camera > Formats > Most Compatible, or share the photo as JPEG).",
    };
  }

  const exts: string[] = [];
  for (const f of files) {
    const ext = EXT_BY_MIME[f.type];
    if (!ext) {
      return { ok: false, error: `Unsupported image type: ${f.type || "unknown"}. Use JPEG, PNG, or WebP.` };
    }
    exts.push(ext);
  }

  const sessionId = randomUUID();
  const dir = path.join(process.cwd(), "public", "practice", sessionId);

  const imagePaths: string[] = [];
  try {
    const images: PracticeImage[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buf = Buffer.from(await file.arrayBuffer());
      const filename = `page-${i + 1}.${exts[i]}`;
      const storedPath = await storeFile(`practice/${sessionId}/${filename}`, buf, file.type);
      imagePaths.push(storedPath);
      images.push({ mediaType: file.type, base64: buf.toString("base64") });
    }

    const extracted = (await extractQuestions(images, { sourceName: sourceName ?? undefined, label })).sort(
      (a, b) => a.number - b.number,
    );

    const allTags = extracted.flatMap((q) => q.tags);
    const resolved = await resolveTags(allTags);
    let cursor = 0;
    const questionsWithTags = extracted.map((q) => {
      const tags: QuestionTag[] = resolved.slice(cursor, cursor + q.tags.length);
      cursor += q.tags.length;
      return { ...q, tags };
    });

    const db = getDb();

    await db.insert(practiceSessions).values({
      id: sessionId,
      label,
      sourceName,
      status: "review",
      imagePaths,
      takenAt,
    });

    // Insert questions one at a time (not a single multi-row insert) so each `.returning()`
    // id is unambiguously tied back to that question's own tags for the questionItems insert
    // below — a multi-row INSERT...RETURNING's row order isn't guaranteed by the SQL standard.
    const questionItemRows: { questionId: string; itemId: string; role: "tested" }[] = [];
    for (let i = 0; i < questionsWithTags.length; i++) {
      const q = questionsWithTags[i];
      const isCorrect =
        q.correctChoice != null && q.userChoice != null ? q.correctChoice === q.userChoice : null;

      const [row] = await db
        .insert(practiceQuestions)
        .values({
          sessionId,
          number: q.number ?? i + 1,
          section: q.section,
          stem: q.stem,
          choices: q.choices,
          correctChoice: q.correctChoice,
          userChoice: q.userChoice,
          isCorrect,
          explanation: q.explanation || null,
          tags: q.tags,
        })
        .returning({ id: practiceQuestions.id });

      for (const tag of q.tags) {
        if (tag.itemId) questionItemRows.push({ questionId: row.id, itemId: tag.itemId, role: "tested" });
      }
    }

    if (questionItemRows.length > 0) {
      await db.insert(questionItems).values(questionItemRows);
    }

    revalidatePath("/practice");
    return { ok: true, sessionId };
  } catch (e) {
    await deleteStoredFiles(imagePaths);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: humanize(e) };
  }
}

export type UpdateQuestionResult = { ok: true } | { ok: false; error: string };

export interface QuestionPatch {
  userChoice?: number | null;
  correctChoice?: number | null;
}

export async function updateQuestion(questionId: string, patch: QuestionPatch): Promise<UpdateQuestionResult> {
  try {
    const db = getDb();
    const [existing] = await db
      .select({
        sessionId: practiceQuestions.sessionId,
        userChoice: practiceQuestions.userChoice,
        correctChoice: practiceQuestions.correctChoice,
      })
      .from(practiceQuestions)
      .where(eq(practiceQuestions.id, questionId));
    if (!existing) return { ok: false, error: "That question no longer exists." };

    const userChoice = patch.userChoice !== undefined ? patch.userChoice : existing.userChoice;
    const correctChoice = patch.correctChoice !== undefined ? patch.correctChoice : existing.correctChoice;
    const isCorrect = userChoice != null && correctChoice != null ? userChoice === correctChoice : null;

    await db
      .update(practiceQuestions)
      .set({ userChoice, correctChoice, isCorrect })
      .where(eq(practiceQuestions.id, questionId));

    revalidatePath(`/practice/${existing.sessionId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanize(e) };
  }
}

export type ConfirmSessionResult = { ok: true } | { ok: false; error: string };

export async function confirmSession(sessionId: string): Promise<ConfirmSessionResult> {
  try {
    const db = getDb();
    const [session] = await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId));
    if (!session) return { ok: false, error: "Session not found." };

    // Idempotent re-confirm: clear any observations this session previously wrote.
    await db.execute(
      sql`DELETE FROM observations WHERE source = 'practice' AND meta->>'sessionId' = ${sessionId}`,
    );

    const questions = await db
      .select({ id: practiceQuestions.id, isCorrect: practiceQuestions.isCorrect })
      .from(practiceQuestions)
      .where(eq(practiceQuestions.sessionId, sessionId));

    const gradedIds = questions.filter((q) => q.isCorrect !== null).map((q) => q.id);
    if (gradedIds.length > 0) {
      const isCorrectByQuestion = new Map(questions.map((q) => [q.id, q.isCorrect]));
      const qItems = await db
        .select({ questionId: questionItems.questionId, itemId: questionItems.itemId })
        .from(questionItems)
        .where(inArray(questionItems.questionId, gradedIds));

      if (qItems.length > 0) {
        await db.insert(observations).values(
          qItems.map((qi) => ({
            itemId: qi.itemId,
            source: "practice" as const,
            kind: "answer" as const,
            correct: isCorrectByQuestion.get(qi.questionId) ?? null,
            occurredAt: session.takenAt,
            meta: { sessionId, questionId: qi.questionId },
          })),
        );
      }
    }

    await db.update(practiceSessions).set({ status: "confirmed" }).where(eq(practiceSessions.id, sessionId));

    revalidatePath("/practice");
    revalidatePath(`/practice/${sessionId}`);
    revalidatePath("/library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanize(e) };
  }
}

// Bound with the row id via `deleteSession.bind(null, id)` in a <form action>.
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const db = getDb();
    const [session] = await db
      .select({ imagePaths: practiceSessions.imagePaths })
      .from(practiceSessions)
      .where(eq(practiceSessions.id, sessionId));

    await db.delete(practiceSessions).where(eq(practiceSessions.id, sessionId));
    await db.execute(
      sql`DELETE FROM observations WHERE source = 'practice' AND meta->>'sessionId' = ${sessionId}`,
    );
    if (session) await deleteStoredFiles(session.imagePaths);
    // Harmless leftover for pre-Blob sessions whose images were never uploaded.
    await rm(path.join(process.cwd(), "public", "practice", sessionId), { recursive: true, force: true }).catch(
      () => {},
    );
    revalidatePath("/practice");
  } catch {
    // Best-effort, mirrors workshop's remove() — a failed delete just leaves the row;
    // the list reflects true DB state on next render.
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
