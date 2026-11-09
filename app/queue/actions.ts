"use server";

import { revalidatePath } from "next/cache";
import { moveVocabQueueStatus, setVocabQueueStatus } from "@/lib/vocab-queue";
import { isVocabQueueStatus } from "@/lib/types";

/** One row → one status; bound from the row's buttons on /queue. */
export async function setStatus(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !isVocabQueueStatus(status)) return;
  await setVocabQueueStatus([id], status);
  revalidatePath("/queue");
}

/** Everything currently queued → carded, for after an Anki import. */
export async function markAllQueuedCarded(): Promise<void> {
  await moveVocabQueueStatus("queued", "carded");
  revalidatePath("/queue");
}
