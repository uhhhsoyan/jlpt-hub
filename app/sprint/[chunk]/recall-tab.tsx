"use client";

import { useRef, useState, useTransition } from "react";
import { recordRecall } from "../actions";
import { useHotkeys } from "./use-hotkeys";
import type { SprintRow } from "./types";
import { Furigana } from "@/app/furigana";

type Phase = "prompt" | "revealed";

export function RecallTab({ rows, chunk }: { rows: SprintRow[]; chunk: number }) {
  const [activeDeck, setActiveDeck] = useState<SprintRow[]>(rows);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("prompt");
  const [correctCount, setCorrectCount] = useState(0);
  const [missed, setMissed] = useState<SprintRow[]>([]);
  const [finished, setFinished] = useState(rows.length === 0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [, startTransition] = useTransition();

  const currentRow = activeDeck[currentIndex];

  function reveal() {
    if (phase !== "prompt" || !currentRow) return;
    setPhase("revealed");
    const audio = audioRef.current;
    if (audio && currentRow.audioPath) {
      audio.src = currentRow.audioPath;
      audio.play().catch(() => {});
    }
  }

  function grade(correct: boolean) {
    if (phase !== "revealed" || !currentRow) return;
    // Fire-and-forget: don't block the drill on the network round trip.
    startTransition(() => void recordRecall(currentRow.itemId, chunk, correct));

    if (correct) setCorrectCount((c) => c + 1);
    else setMissed((m) => [...m, currentRow]);

    if (currentIndex + 1 >= activeDeck.length) {
      setFinished(true);
    } else {
      setCurrentIndex((i) => i + 1);
      setPhase("prompt");
    }
  }

  useHotkeys({
    Space: reveal,
    KeyK: () => grade(true),
    KeyJ: () => grade(false),
  });

  function retryMisses() {
    setActiveDeck(missed);
    setCurrentIndex(0);
    setPhase("prompt");
    setCorrectCount(0);
    setMissed([]);
    setFinished(missed.length === 0);
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
        Nothing to recall in this deck.
      </p>
    );
  }

  if (finished) {
    return (
      <div className="flex flex-col items-center gap-5 rounded-2xl border border-neutral-200 bg-white p-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-2xl font-bold">
          {correctCount} / {activeDeck.length} correct
        </p>
        {missed.length > 0 ? (
          <>
            <div className="flex w-full flex-col gap-1 text-left">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Missed</h3>
              <ul className="flex flex-col gap-1">
                {missed.map((row) => (
                  <li key={row.id} className="text-sm text-neutral-600 dark:text-neutral-300">
                    <span className="font-medium">{row.headword}</span>{" "}
                    <span className="text-neutral-400">{row.meaning}</span>
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={retryMisses}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              Retry misses ({missed.length})
            </button>
          </>
        ) : (
          <p className="text-sm text-neutral-400">Clean pass — nothing missed.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <audio ref={audioRef} className="hidden" />

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all"
          style={{ width: `${(currentIndex / activeDeck.length) * 100}%` }}
        />
      </div>
      <span className="self-end text-xs text-neutral-400">
        {currentIndex + 1} / {activeDeck.length}
      </span>

      <div className="flex flex-col items-center gap-6 rounded-2xl border border-neutral-200 bg-white p-10 text-center dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-2xl leading-snug">{currentRow.english}</p>

        {phase === "prompt" ? (
          <>
            <p className="text-sm text-neutral-400">Say it in Japanese, out loud.</p>
            <button
              type="button"
              onClick={reveal}
              className="rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Reveal (Space)
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Furigana
                japanese={currentRow.japanese}
                reading={currentRow.reading}
                className="text-3xl leading-[1.9]"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => grade(false)}
                className="rounded-full bg-red-50 px-5 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70"
              >
                ✗ Missed (J)
              </button>
              <button
                type="button"
                onClick={() => grade(true)}
                className="rounded-full bg-emerald-50 px-5 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
              >
                ✓ Correct (K)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
