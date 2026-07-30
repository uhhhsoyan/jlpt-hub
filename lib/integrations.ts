import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { integrationSettings } from "@/lib/db/schema";
import type { IntegrationSource } from "@/lib/types";

/**
 * Kill switch for external evidence sources. No settings row means enabled —
 * integrations are already opt-in via their env keys; the row only exists once
 * the user flips the toggle in the Integrations panel.
 */
export async function isIntegrationEnabled(source: IntegrationSource): Promise<boolean> {
  const [row] = await getDb()
    .select({ enabled: integrationSettings.enabled })
    .from(integrationSettings)
    .where(eq(integrationSettings.source, source));
  return row?.enabled ?? true;
}

export async function setIntegrationEnabled(
  source: IntegrationSource,
  enabled: boolean,
): Promise<void> {
  await getDb()
    .insert(integrationSettings)
    .values({ source, enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrationSettings.source,
      set: { enabled, updatedAt: new Date() },
    });
}
