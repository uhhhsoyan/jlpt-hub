"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { markChunkListened } from "../actions";
import { useHotkeys } from "./use-hotkeys";
import type { SprintRow } from "./types";

type Speed = 1 | 1.25 | 1.5;
const SPEEDS: Speed[] = [1, 1.25, 1.5];

function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function ListenTab({ rows, chunk }: { rows: SprintRow[]; chunk: number }) {
  // Indices into `rows` for entries that actually have audio; playback skips the rest.
  const playable = useMemo(() => rows.map((_, i) => i).filter((i) => rows[i].audioPath), [rows]);
  const missingCount = rows.length - playable.length;

  const [shuffle, setShuffle] = useState(false);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const [queue, setQueue] = useState<number[]>(playable);
  const [qPos, setQPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  // True once several tracks in a row failed to load — e.g. on a deployed build, where the
  // locally generated MP3s under public/sprint/ don't exist even though audioPath is set.
  const [audioDead, setAudioDead] = useState(false);
  const errorStreak = useRef(0);
  const completedThisPass = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [, startTransition] = useTransition();

  // Toggling shuffle rebuilds the queue right away, keeping whatever was already playing at the
  // same logical position. This runs in the click handler (not an effect) since it's a direct
  // response to a user action, not a sync with an external system.
  function toggleShuffle() {
    const nextShuffle = !shuffle;
    const currentRowIndex = queue[qPos];
    const ordered = nextShuffle ? shuffledIndices(playable.length).map((i) => playable[i]) : playable;
    const resumeAt = ordered.indexOf(currentRowIndex);
    setShuffle(nextShuffle);
    setQueue(ordered);
    setQPos(resumeAt >= 0 ? resumeAt : 0);
  }

  const currentRowIndex: number | undefined = queue[qPos];
  const currentRow = currentRowIndex !== undefined ? rows[currentRowIndex] : undefined;

  // Load + (maybe) play whenever the current track changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentRow?.audioPath) return;
    audio.src = currentRow.audioPath;
    audio.playbackRate = speed;
    audio.preservesPitch = true;
    if (playing) audio.play().catch(() => setPlaying(false));
    // Deliberately excluding `speed`/`playing` — those are applied by their own effects below so
    // changing them doesn't restart the current track from the top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRow?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.playbackRate = speed;
      audio.preservesPitch = true;
    }
  }, [speed]);

  function advance() {
    const atEnd = qPos + 1 >= queue.length;
    if (!atEnd) {
      setQPos(qPos + 1);
      return;
    }

    // A full pass just completed. Only unshuffled passes where audio actually finished
    // playing count toward listenCount — a walk of load errors is not a listen.
    if (!shuffle && completedThisPass.current > 0) {
      startTransition(() => void markChunkListened(chunk));
    }
    completedThisPass.current = 0;

    if (!loop) {
      setPlaying(false);
      return;
    }
    if (shuffle) setQueue(shuffledIndices(playable.length).map((i) => playable[i]));
    setQPos(0);
  }

  function handleEnded() {
    errorStreak.current = 0;
    completedThisPass.current += 1;
    advance();
  }

  function handleError() {
    // A load failure before the user ever hits Play must not start the playlist walking
    // on its own; and repeated failures while playing mean the files aren't reachable —
    // stop and say so instead of spinning through the whole deck.
    if (!playing) return;
    errorStreak.current += 1;
    if (errorStreak.current >= Math.min(queue.length, 5)) {
      setPlaying(false);
      setAudioDead(true);
      return;
    }
    advance();
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      setAudioDead(false);
      errorStreak.current = 0;
      if (audio.error) audio.load(); // retry the current src after a failed load
      audio.play().catch(() => {});
      setPlaying(true);
    }
  }

  function goNext() {
    advance();
  }
  function goPrev() {
    setQPos((pos) => Math.max(0, pos - 1));
  }

  useHotkeys({
    Space: togglePlay,
    ArrowRight: goNext,
    ArrowLeft: goPrev,
  });

  if (playable.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
        No audio yet — run <code>npm run sprint:tts</code>.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 rounded-2xl border border-neutral-200 bg-white p-8 dark:border-neutral-800 dark:bg-neutral-900">
      <audio
        ref={audioRef}
        onEnded={handleEnded}
        onError={handleError}
        className="hidden"
      />

      {audioDead && (
        <p className="max-w-md text-center text-xs text-amber-600 dark:text-amber-400">
          Audio isn&apos;t loading here. The MP3s live on the machine that generated them
          (<code>public/sprint/</code> isn&apos;t deployed) — use the app locally, or wait for
          the cloud-storage upgrade.
        </p>
      )}

      {missingCount > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {missingCount} missing audio — run <code>npm run sprint:tts</code>
        </p>
      )}

      <span className="text-xs text-neutral-400">
        {currentRowIndex !== undefined ? currentRowIndex + 1 : 0} / {rows.length}
      </span>

      <p className="text-center text-3xl leading-snug">{currentRow?.japanese ?? "—"}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={goPrev}
          className="rounded-lg px-3 py-2 text-sm text-neutral-500 transition hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={togglePlay}
          className="rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={goNext}
          className="rounded-lg px-3 py-2 text-sm text-neutral-500 transition hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Next →
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4">
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                speed === s
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                  : "bg-neutral-100 text-neutral-500 hover:text-neutral-900 dark:bg-neutral-800 dark:hover:text-neutral-100"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>

        <Toggle label="Loop" value={loop} onToggle={() => setLoop((l) => !l)} />
        <Toggle label="Shuffle" value={shuffle} onToggle={toggleShuffle} />
      </div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={value}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
        value
          ? "bg-indigo-600 text-white"
          : "bg-neutral-100 text-neutral-500 hover:text-neutral-900 dark:bg-neutral-800 dark:hover:text-neutral-100"
      }`}
    >
      {label}
    </button>
  );
}
