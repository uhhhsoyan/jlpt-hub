import Link from "next/link";
import type { FeedFilter, FeedModeFilter, FeedSource } from "@/lib/study-feed";
import { journalHref } from "./href";

const MODES: { mode: FeedModeFilter; label: string }[] = [
  { mode: "all", label: "All" },
  { mode: "practice", label: "Closed book" },
  { mode: "lesson", label: "Open book" },
];

const pill = (active: boolean) =>
  `inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-semibold transition ${
    active
      ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
      : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200"
  }`;

/**
 * Filters as plain links (server-rendered, shareable): mode, misses only, and a source row
 * listing the sources seen in this window. Changing a filter keeps the window.
 */
export function JournalFilters({ to, filter, sources }: { to: string | null; filter: FeedFilter; sources: FeedSource[] }) {
  const href = (patch: Partial<FeedFilter>) => journalHref({ to, filter: { ...filter, ...patch } });
  // Keep a source chip for the active filter even when the window has nothing from it.
  const chips = filter.source && !sources.some((s) => s.slug === filter.source) ? [...sources, { slug: filter.source, name: filter.source }] : sources;
  return (
    <nav aria-label="Filters" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {MODES.map((m) => (
          <Link key={m.mode} href={href({ mode: m.mode })} className={pill(filter.mode === m.mode)} aria-current={filter.mode === m.mode ? "true" : undefined}>
            {m.label}
          </Link>
        ))}
        <span className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden />
        <Link href={href({ missesOnly: !filter.missesOnly })} className={pill(filter.missesOnly)} aria-pressed={filter.missesOnly}>
          {filter.missesOnly ? "✓ " : ""}Misses only
        </Link>
      </div>
      {chips.length > 1 || filter.source ? (
        <div className="flex flex-wrap gap-1.5">
          <Link href={href({ source: null })} className={chip(filter.source === null)}>
            All sources
          </Link>
          {chips.map((s) => (
            <Link key={s.slug} href={href({ source: s.slug })} className={chip(filter.source === s.slug)}>
              {s.name}
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}

function chip(active: boolean): string {
  return `inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium transition ${
    active
      ? "border-indigo-600 bg-indigo-600 text-white"
      : "border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300"
  }`;
}
