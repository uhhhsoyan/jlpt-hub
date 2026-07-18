"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipRow } from "@/lib/db/schema";
import type { SprintRow } from "./types";

type Phase = "easy" | "hard";
type IntervalMin = 3 | 5 | 10;
const INTERVALS: IntervalMin[] = [3, 5, 10];

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SandwichTab({ rows, clips }: { rows: SprintRow[]; clips: ClipRow[] }) {
  const easyQueue = useMemo(() => rows.filter((r) => r.audioPath), [rows]);
  const [hardQueue, setHardQueue] = useState<ClipRow[]>(() => shuffled(clips));

  const [phase, setPhase] = useState<Phase>("easy");
  const [intervalMin, setIntervalMin] = useState<IntervalMin>(5);
  const [remaining, setRemaining] = useState(intervalMin * 60);
  const [paused, setPaused] = useState(false);
  const [easyIdx, setEasyIdx] = useState(0);
  const [hardIdx, setHardIdx] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);

  // Countdown, ticking once per second while unpaused.
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setPhase((p) => (p === "easy" ? "hard" : "easy"));
          return intervalMin * 60;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [paused, intervalMin]);

  // Changing the interval resets the clock for the current phase right away.
  function changeInterval(min: IntervalMin) {
    setIntervalMin(min);
    setRemaining(min * 60);
  }

  const currentEasy = easyQueue[easyIdx % Math.max(easyQueue.length, 1)];
  const currentHard = hardQueue[hardIdx % Math.max(hardQueue.length, 1)];

  // Load + play whichever track is current for the active phase.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || paused) return;
    const src = phase === "easy" ? currentEasy?.audioPath : currentHard?.audioUrl;
    if (!src) return;
    audio.src = src;
    audio.playbackRate = 1;
    audio.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, currentEasy?.id, currentHard?.id, paused]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (paused) audio.pause();
  }, [paused]);

  function advance() {
    if (phase === "easy") {
      setEasyIdx((i) => (i + 1 >= easyQueue.length ? 0 : i + 1));
    } else {
      setHardIdx((i) => {
        const next = i + 1;
        if (next >= hardQueue.length) {
          setHardQueue(shuffled(clips));
          return 0;
        }
        return next;
      });
    }
  }

  function backToEasy() {
    setPhase("easy");
    setRemaining(intervalMin * 60);
  }

  if (easyQueue.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
        No deck audio yet — run <code>npm run sprint:tts</code>.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <audio ref={audioRef} onEnded={advance} onError={advance} className="hidden" />

      <div
        className={`flex flex-col items-center gap-3 rounded-2xl border p-8 text-center transition-colors duration-500 ${
          phase === "easy"
            ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
            : "border-orange-300 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/30"
        }`}
      >
        <span
          className={`text-xs font-bold uppercase tracking-wide ${
            phase === "easy"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-orange-700 dark:text-orange-400"
          }`}
        >
          {phase === "easy" ? "EASY — deck audio" : "HARD — native clips"}
        </span>
        <span className="text-4xl font-bold tabular-nums">{formatTime(remaining)}</span>

        {phase === "easy" ? (
          <p className="text-lg leading-snug">{currentEasy?.japanese ?? "—"}</p>
        ) : currentHard ? (
          <div className="flex flex-col gap-1">
            <p className="text-lg leading-snug">{currentHard.japanese}</p>
            <p className="text-xs text-neutral-400">{currentHard.sourceLabel}</p>
          </div>
        ) : (
          <p className="text-sm text-neutral-400">No clips available.</p>
        )}

        <div className="mt-2 flex gap-3">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="rounded-lg bg-white/70 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-white dark:bg-black/20 dark:text-neutral-200 dark:hover:bg-black/30"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          {phase === "hard" && (
            <button
              type="button"
              onClick={backToEasy}
              className="rounded-lg bg-white/70 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-white dark:bg-black/20 dark:text-neutral-200 dark:hover:bg-black/30"
            >
              Too hard — back to easy
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2">
        <span className="text-xs text-neutral-400">Interval</span>
        {INTERVALS.map((min) => (
          <button
            key={min}
            type="button"
            onClick={() => changeInterval(min)}
            aria-pressed={intervalMin === min}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              intervalMin === min
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-500 hover:text-neutral-900 dark:bg-neutral-800 dark:hover:text-neutral-100"
            }`}
          >
            {min} min
          </button>
        ))}
      </div>
    </div>
  );
}
