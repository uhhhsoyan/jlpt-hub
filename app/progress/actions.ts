"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bpSnapshot, observations, wkSnapshot } from "@/lib/db/schema";
import { setIntegrationEnabled } from "@/lib/integrations";
import { syncWanikani, type WkSyncResult } from "@/lib/wanikani";
import { syncBunpro, type BpSyncResult } from "@/lib/bunpro";
import type { IntegrationSource } from "@/lib/types";

function revalidateEvidencePages() {
  revalidatePath("/progress");
  revalidatePath("/library");
  revalidatePath("/"); // schedule shows the synced level snapshot
}

export async function runWanikaniSync(): Promise<WkSyncResult> {
  const result = await syncWanikani();
  if (result.ok) revalidateEvidencePages();
  return result;
}

export async function runBunproSync(): Promise<BpSyncResult> {
  const result = await syncBunpro();
  if (result.ok) revalidateEvidencePages();
  return result;
}

export type IntegrationActionResult = { ok: true } | { ok: false; error: string };

function assertSource(source: string): asserts source is IntegrationSource {
  if (source !== "wanikani" && source !== "bunpro") {
    throw new Error(`Unknown integration: ${source}`);
  }
}

/** Flip an integration's kill switch; every sync path (cron, visit, button) honors it. */
export async function toggleIntegration(
  source: string,
  enabled: boolean,
): Promise<IntegrationActionResult> {
  try {
    assertSource(source);
    await setIntegrationEnabled(source, enabled);
    revalidateEvidencePages();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/**
 * Remove every trace of an integration from progress tracking: its observations
 * (mastery is computed from the ledger at read time, so scores update immediately)
 * and its sync snapshot. Item mappings in detail jsonb are inert metadata and are
 * kept, so re-enabling later picks up exactly where things left off.
 */
export async function purgeIntegration(source: string): Promise<IntegrationActionResult> {
  try {
    assertSource(source);
    const db = getDb();
    await db.delete(observations).where(eq(observations.source, source));
    if (source === "wanikani") await db.delete(wkSnapshot).where(eq(wkSnapshot.id, 1));
    else await db.delete(bpSnapshot).where(eq(bpSnapshot.id, 1));
    revalidateEvidencePages();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}
