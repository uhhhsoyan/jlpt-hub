"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { observations, sprintChunks } from "@/lib/db/schema";
import { errChain, firstLine } from "@/app/workshop/db-error";

export type RecordRecallResult = { ok: true } | { ok: false; error: string };

/** Each Recall grade writes one evidence row to the knowledge graph. Fire-and-forget from the client. */
export async function recordRecall(
  itemId: string,
  chunk: number,
  correct: boolean,
): Promise<RecordRecallResult> {
  try {
    await getDb()
      .insert(observations)
      .values({
        itemId,
        source: "sprint",
        kind: "answer",
        correct,
        occurredAt: new Date(),
        meta: { chunk },
      });
    revalidatePath("/sprint");
    revalidatePath("/library");
    revalidatePath("/progress");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: firstLine(errChain(e)) };
  }
}

export type MarkChunkListenedResult = { ok: true } | { ok: false; error: string };

/** Called once per completed unshuffled pass through a deck's Listen playlist. */
export async function markChunkListened(chunk: number): Promise<MarkChunkListenedResult> {
  try {
    await getDb()
      .insert(sprintChunks)
      .values({ chunk, listenCount: 1, lastListenedAt: new Date() })
      .onConflictDoUpdate({
        target: sprintChunks.chunk,
        set: {
          listenCount: sql`${sprintChunks.listenCount} + 1`,
          lastListenedAt: new Date(),
        },
      });
    revalidatePath("/sprint");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: firstLine(errChain(e)) };
  }
}
