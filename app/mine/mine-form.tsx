"use client";

import { useState, useTransition } from "react";
import { mine, saveClips, type ClipToSave } from "./actions";
import type { MinedSegment } from "@/lib/mine";

interface Row extends MinedSegment {
  keep: boolean;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function MineForm() {
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<{ url: string; title: string } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mining, startMine] = useTransition();
  const [saving, startSave] = useTransition();

  function onMine() {
    setError(null);
    setNotice(null);
    setRows([]);
    setMeta(null);
    startMine(async () => {
      const r = await mine(url);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setMeta({ url: r.url, title: r.title });
      setRows(r.segments.map((s) => ({ ...s, keep: false })));
      if (r.segments.length === 0) setNotice("No speech segments found.");
    });
  }

  function onSave() {
    if (!meta) return;
    const kept: ClipToSave[] = rows
      .filter((r) => r.keep && r.text.trim())
      .map((r) => ({ japanese: r.text, audioUrl: r.clipUrl, startSec: r.start, endSec: r.end }));
    if (kept.length === 0) {
      setError("Tick at least one clip to save.");
      return;
    }
    setError(null);
    startSave(async () => {
      const r = await saveClips(meta.url, meta.title, kept);
      if (r.ok) {
        setNotice(`Saved ${r.count} clip${r.count === 1 ? "" : "s"} below.`);
        setRows((prev) => prev.map((row) => (row.keep ? { ...row, keep: false } : row)));
      } else {
        setError(r.error);
      }
    });
  }

  const keptCount = rows.filter((r) => r.keep && r.text.trim()).length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="url" className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
          YouTube URL — a listening video (e.g. Mochi Sensei)
        </label>
        <div className="flex gap-2">
          <input
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            className="flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-indigo-900"
          />
          <button
            onClick={onMine}
            disabled={mining || !url.trim()}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            {mining ? "Transcribing…" : "Mine"}
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          Downloads the audio, transcribes it with Whisper, and slices a clip per sentence. Runs
          locally; a full video can take a couple of minutes.
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </p>
      )}

      {rows.length > 0 && meta && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-neutral-500">
              <span className="font-medium text-neutral-700 dark:text-neutral-200">{meta.title}</span> —{" "}
              {rows.length} segments. Play each, fix the text, tick the keepers.
            </p>
            <button
              onClick={onSave}
              disabled={saving || keptCount === 0}
              className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
            >
              {saving ? "Saving…" : `Save ${keptCount || ""} clips`}
            </button>
          </div>

          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <li
                key={row.index}
                className={`flex items-start gap-3 rounded-xl border p-3 ${
                  row.keep
                    ? "border-emerald-400 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20"
                    : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                }`}
              >
                <input
                  type="checkbox"
                  checked={row.keep}
                  onChange={() =>
                    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, keep: !r.keep } : r)))
                  }
                  className="mt-1 size-4 shrink-0 accent-emerald-600"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <audio controls preload="none" src={row.clipUrl} className="h-8 w-64 max-w-full" />
                    <span className="text-xs text-neutral-400">{fmtTime(row.start)}</span>
                    {row.reads > 1 && (
                      <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                        read ×{row.reads}
                      </span>
                    )}
                  </div>
                  <textarea
                    value={row.text}
                    onChange={(e) =>
                      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)))
                    }
                    rows={1}
                    className="w-full resize-none rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[15px] outline-none focus:border-indigo-500 dark:border-neutral-700 dark:bg-neutral-800"
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
