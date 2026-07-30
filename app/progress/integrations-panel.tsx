"use client";

import { useState, useTransition } from "react";
import {
  runWanikaniSync,
  runBunproSync,
  toggleIntegration,
  purgeIntegration,
} from "./actions";
import type { IntegrationSource } from "@/lib/types";

export interface IntegrationState {
  source: IntegrationSource;
  configured: boolean;
  enabled: boolean;
  /** ISO timestamp of the last successful sync; null when never synced (or purged). */
  syncedAt: string | null;
  /** How many rows this source currently contributes to the evidence ledger. */
  observationCount: number;
}

const META: Record<IntegrationSource, { name: string; covers: string; envVar: string }> = {
  wanikani: { name: "WaniKani", covers: "kanji + vocab SRS", envVar: "WANIKANI_TOKEN" },
  bunpro: { name: "Bunpro", covers: "grammar SRS", envVar: "BUNPRO_API_KEY" },
};

export function IntegrationsPanel({ integrations }: { integrations: IntegrationState[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Integrations
        </h2>
        <p className="text-xs text-neutral-400">
          External SRS tools feeding the evidence ledger. Each can be paused (stops all
          syncing) or have its data removed — mastery recomputes instantly either way.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {integrations.map((integration) => (
          <IntegrationRow key={integration.source} integration={integration} />
        ))}
      </ul>
    </section>
  );
}

function IntegrationRow({ integration }: { integration: IntegrationState }) {
  const { source, configured, enabled, syncedAt, observationCount } = integration;
  const meta = META[source];
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  function report(ok: boolean, text: string) {
    setIsError(!ok);
    setMessage(text);
  }

  function onSync() {
    setMessage(null);
    setConfirmingPurge(false);
    startTransition(async () => {
      const result = source === "wanikani" ? await runWanikaniSync() : await runBunproSync();
      if (result.ok) {
        const s = result.summary;
        report(
          true,
          `${s.observationsWritten.toLocaleString()} observations from ${s.itemsMapped.toLocaleString()} mapped items.`,
        );
      } else {
        report(false, result.error);
      }
    });
  }

  function onToggle() {
    setMessage(null);
    setConfirmingPurge(false);
    startTransition(async () => {
      const result = await toggleIntegration(source, !enabled);
      if (result.ok) report(true, enabled ? "Paused — no sync will run." : "Enabled.");
      else report(false, result.error);
    });
  }

  function onPurge() {
    if (!confirmingPurge) {
      setMessage(null);
      setConfirmingPurge(true);
      return;
    }
    setConfirmingPurge(false);
    startTransition(async () => {
      const result = await purgeIntegration(source);
      if (result.ok) {
        report(
          true,
          enabled && configured
            ? "Data removed. Still enabled, so the next sync will bring it back — pause it to keep it out."
            : "Data removed.",
        );
      } else {
        report(false, result.error);
      }
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{meta.name}</span>
        <span className="text-xs text-neutral-400">{meta.covers}</span>
        {!configured ? (
          <Chip tone="neutral">not configured — set {meta.envVar}</Chip>
        ) : enabled ? (
          <Chip tone="ok">active</Chip>
        ) : (
          <Chip tone="warn">paused</Chip>
        )}
      </div>

      {/* toLocaleString differs between server and browser timezones; the client value wins. */}
      <p className="text-xs text-neutral-400" suppressHydrationWarning>
        {observationCount.toLocaleString()} observation{observationCount === 1 ? "" : "s"} in the
        ledger
        {syncedAt
          ? ` · last synced ${new Date(syncedAt).toLocaleString()}`
          : " · never synced"}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onSync}
          disabled={pending || !configured || !enabled}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {pending ? "Working…" : "Sync now"}
        </button>
        <button
          onClick={onToggle}
          disabled={pending}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {enabled ? "Pause" : "Enable"}
        </button>
        <button
          onClick={onPurge}
          disabled={pending || observationCount === 0}
          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${
            confirmingPurge
              ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          }`}
        >
          {confirmingPurge
            ? `Really remove ${observationCount.toLocaleString()} observations?`
            : "Remove data"}
        </button>
        {confirmingPurge && (
          <button
            onClick={() => setConfirmingPurge(false)}
            className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            Cancel
          </button>
        )}
      </div>

      {message && (
        <p
          className={
            isError
              ? "text-xs text-red-600 dark:text-red-400"
              : "text-xs text-neutral-500 dark:text-neutral-400"
          }
        >
          {message}
        </p>
      )}
    </li>
  );
}

function Chip({ tone, children }: { tone: "ok" | "warn" | "neutral"; children: React.ReactNode }) {
  const styles = {
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    neutral: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[tone]}`}>
      {children}
    </span>
  );
}
