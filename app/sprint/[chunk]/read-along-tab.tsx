"use client";

import { useRef, useState } from "react";
import type { SprintRow } from "./types";

export function ReadAlongTab({ rows }: { rows: SprintRow[] }) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  function play(row: SprintRow) {
    const audio = audioRef.current;
    if (!audio || !row.audioPath) return;
    audio.src = row.audioPath;
    setPlayingId(row.id);
    audio.play().catch(() => setPlayingId(null));
  }

  function playNextAfterError(row: SprintRow) {
    const idx = rows.findIndex((r) => r.id === row.id);
    const next = rows.slice(idx + 1).find((r) => r.audioPath);
    if (next) play(next);
    else setPlayingId(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <audio
        ref={audioRef}
        onEnded={() => setPlayingId(null)}
        onError={() => {
          const row = rows.find((r) => r.id === playingId);
          if (row) playNextAfterError(row);
        }}
        className="hidden"
      />
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`flex items-start gap-3 rounded-xl border p-4 transition ${
              playingId === row.id
                ? "border-indigo-400 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/30"
                : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
            }`}
          >
            <button
              type="button"
              onClick={() => play(row)}
              disabled={!row.audioPath}
              aria-label="Play sentence audio"
              className="mt-1 shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600 transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {playingId === row.id ? "▶" : "▷"}
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-lg leading-snug">{row.japanese}</p>
              <p className="text-sm text-neutral-400">{row.reading}</p>
              <p className="text-sm text-neutral-400">{row.english}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
