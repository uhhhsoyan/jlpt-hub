import type { JlptLevel } from "@/lib/types";

export type LevelFilter = "All" | "N5" | "N4";

const LEVEL_FILTERS: LevelFilter[] = ["All", "N5", "N4"];

export function matchesLevel(level: JlptLevel, filter: LevelFilter): boolean {
  return filter === "All" || level === filter;
}

/** Case-insensitive substring match across any number of (possibly absent) text fields. */
export function matchesQuery(fields: Array<string | null | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

interface LibraryToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  level: LevelFilter;
  onLevelChange: (value: LevelFilter) => void;
  placeholder: string;
}

export function LibraryToolbar({
  query,
  onQueryChange,
  level,
  onLevelChange,
  placeholder,
}: LibraryToolbarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50 dark:focus:border-neutral-600 sm:max-w-xs"
      />
      <div className="flex gap-1">
        {LEVEL_FILTERS.map((lv) => (
          <button
            key={lv}
            type="button"
            onClick={() => onLevelChange(lv)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              level === lv
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
            }`}
          >
            {lv}
          </button>
        ))}
      </div>
    </div>
  );
}
