"use client";

import { useMemo, useState } from "react";
import { LevelBadge } from "@/app/workshop/level-badge";
import type { LibraryItem } from "./types";
import { groupByGojuon } from "./gojuon";
import { MasteryDot } from "./mastery-dot";
import { LibraryToolbar, matchesLevel, matchesQuery, type LevelFilter } from "./toolbar";

export function VocabTab({ items }: { items: LibraryItem[] }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("All");

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          matchesLevel(item.level, level) &&
          matchesQuery([item.headword, item.reading, item.romaji, item.meaning], query),
      ),
    [items, query, level],
  );

  const groups = useMemo(() => groupByGojuon(filtered), [filtered]);

  return (
    <div className="flex flex-col gap-5">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        level={level}
        onLevelChange={setLevel}
        placeholder="Search word, reading, or meaning…"
      />

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-400">No vocab matches your search.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.row} className="flex flex-col gap-2">
              <h3 className="sticky top-14 z-10 w-fit rounded bg-neutral-50/90 px-1 text-sm font-bold text-neutral-400 backdrop-blur dark:bg-neutral-950/90 dark:text-neutral-500">
                {group.row}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-lg leading-snug">{item.headword}</span>
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        {item.reading}
                      </span>
                      {item.romaji && (
                        <span className="text-xs text-neutral-400 dark:text-neutral-600">
                          {item.romaji}
                        </span>
                      )}
                      <span className="w-full text-sm text-neutral-600 dark:text-neutral-300 sm:w-auto">
                        {item.meaning}
                      </span>
                    </div>
                    <LevelBadge level={item.level} />
                    <MasteryDot />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
