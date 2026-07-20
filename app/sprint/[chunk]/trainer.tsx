"use client";

import { useState } from "react";
import type { ClipRow } from "@/lib/db/schema";
import type { SprintRow } from "./types";
import { ListenTab } from "./listen-tab";
import { ReadAlongTab } from "./read-along-tab";
import { RecallTab } from "./recall-tab";
import { SandwichTab } from "./sandwich-tab";

type Mode = "listen" | "read" | "recall" | "sandwich";

const TABS: { id: Mode; label: string }[] = [
  { id: "listen", label: "Listen" },
  { id: "read", label: "Read-along" },
  { id: "recall", label: "Recall" },
  { id: "sandwich", label: "Sandwich" },
];

export function Trainer({ chunk, rows, clips }: { chunk: number; rows: SprintRow[]; clips: ClipRow[] }) {
  const [mode, setMode] = useState<Mode>("listen");
  const hasClips = clips.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {TABS.map((tab) => {
          const disabled = tab.id === "sandwich" && !hasClips;
          return (
            <button
              key={tab.id}
              type="button"
              disabled={disabled}
              onClick={() => setMode(tab.id)}
              aria-pressed={mode === tab.id}
              title={disabled ? "Mine some clips first (Mine tab)" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition ${
                disabled
                  ? "cursor-not-allowed border-transparent text-neutral-300 dark:text-neutral-700"
                  : mode === tab.id
                    ? "border-neutral-900 text-neutral-900 dark:border-white dark:text-white"
                    : "border-transparent text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {mode === "listen" && <ListenTab rows={rows} chunk={chunk} />}
      {mode === "read" && <ReadAlongTab rows={rows} />}
      {mode === "recall" && <RecallTab rows={rows} chunk={chunk} />}
      {mode === "sandwich" &&
        (hasClips ? (
          <SandwichTab rows={rows} clips={clips} />
        ) : (
          <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
            Mine some clips first (Mine tab) before sandwiching this deck.
          </p>
        ))}
    </div>
  );
}
