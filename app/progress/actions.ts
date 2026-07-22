"use server";

import { revalidatePath } from "next/cache";
import { syncWanikani, type WkSyncResult } from "@/lib/wanikani";

export async function runWanikaniSync(): Promise<WkSyncResult> {
  const result = await syncWanikani();
  if (result.ok) {
    revalidatePath("/progress");
    revalidatePath("/library");
    revalidatePath("/"); // schedule shows the synced level snapshot
  }
  return result;
}
