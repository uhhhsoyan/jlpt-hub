"use client";

import { useMemo, useState } from "react";
import { LevelBadge } from "@/app/workshop/level-badge";
import type { LibraryItem } from "./types";
import { LibraryToolbar, matchesLevel, matchesQuery, type LevelFilter } from "./toolbar";

const WORDS_CAP = 30;

export function KanjiTab({ items, vocab }: { items: LibraryItem[]; vocab: LibraryItem[] }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          matchesLevel(item.level, level) &&
          matchesQuery([item.headword, item.meaning, item.onyomi, item.kunyomi], query),
      ),
    [items, query, level],
  );

  // Looked up from the full (unfiltered) kanji list so the detail panel doesn't vanish
  // just because a later search/level change hides the selected card from the grid.
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  const relatedWords = useMemo(() => {
    if (!selected) return [];
    return vocab.filter((word) => word.headword.includes(selected.headword));
  }, [vocab, selected]);

  return (
    <div className="flex flex-col gap-5">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        level={level}
        onLevelChange={setLevel}
        placeholder="Search kanji or meaning…"
      />

      {selected && (
        <KanjiDetail kanji={selected} relatedWords={relatedWords} onClose={() => setSelectedId(null)} />
      )}

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-400">No kanji match your search.</p>
      ) : (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              aria-pressed={selectedId === item.id}
              className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center transition ${
                selectedId === item.id
                  ? "border-neutral-900 bg-neutral-100 dark:border-white dark:bg-neutral-800"
                  : "border-neutral-200 bg-white hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
              }`}
            >
              <span className="text-2xl leading-none">{item.headword}</span>
              <span className="line-clamp-1 w-full text-[11px] text-neutral-500 dark:text-neutral-400">
                {item.meaning}
              </span>
              <LevelBadge level={item.level} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function KanjiDetail({
  kanji,
  relatedWords,
  onClose,
}: {
  kanji: LibraryItem;
  relatedWords: LibraryItem[];
  onClose: () => void;
}) {
  const shown = relatedWords.slice(0, WORDS_CAP);
  const extra = relatedWords.length - shown.length;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <span className="text-5xl leading-none">{kanji.headword}</span>
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center gap-2">
              <LevelBadge level={kanji.level} />
              <span className="text-neutral-600 dark:text-neutral-300">{kanji.meaning}</span>
            </div>
            {kanji.onyomi && (
              <p className="text-neutral-500 dark:text-neutral-400">
                <span className="text-neutral-400 dark:text-neutral-500">On&nbsp;</span>
                {kanji.onyomi}
              </p>
            )}
            {kanji.kunyomi && (
              <p className="text-neutral-500 dark:text-neutral-400">
                <span className="text-neutral-400 dark:text-neutral-500">Kun&nbsp;</span>
                {kanji.kunyomi}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-xs text-neutral-400 transition hover:text-neutral-700 dark:hover:text-neutral-200"
          aria-label="Close detail"
        >
          Close
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Words using 漢字
        </h4>
        {shown.length === 0 ? (
          <p className="text-sm text-neutral-400">No vocab in the library uses this kanji.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((word) => (
              <li key={word.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span>{word.headword}</span>
                <span className="text-neutral-500 dark:text-neutral-400">{word.reading}</span>
                <span className="text-neutral-400 dark:text-neutral-600">{word.meaning}</span>
              </li>
            ))}
          </ul>
        )}
        {extra > 0 && <p className="text-xs text-neutral-400">+{extra} more</p>}
      </div>
    </div>
  );
}
