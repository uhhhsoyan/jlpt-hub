import type { FeedFilter } from "@/lib/study-feed";

export interface JournalQuery {
  /** Newest day of the window; null = today. */
  to: string | null;
  filter: FeedFilter;
}

/** The journal URL for a window and filter set; defaults are left out so "/" stays "/". */
export function journalHref({ to, filter }: JournalQuery): string {
  const p = new URLSearchParams();
  if (to) p.set("to", to);
  if (filter.source) p.set("source", filter.source);
  if (filter.mode !== "all") p.set("mode", filter.mode);
  if (filter.missesOnly) p.set("misses", "1");
  const s = p.toString();
  return s ? `/?${s}` : "/";
}
