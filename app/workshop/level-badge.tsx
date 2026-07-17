import type { VocabLevel } from "@/lib/types";

const STYLES: Record<VocabLevel, string> = {
  N5: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  N4: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  N3: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  N2: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  N1: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  other: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

export function LevelBadge({ level }: { level: VocabLevel }) {
  return (
    <span
      className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${STYLES[level]}`}
    >
      {level === "other" ? "—" : level}
    </span>
  );
}
