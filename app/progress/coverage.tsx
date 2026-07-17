import type { MasteryStatus } from "@/lib/types";

/** Same status set as lib/mastery.ts's masteryStatus(); kept as its own alias for clarity here. */
export type CoverageStatus = MasteryStatus;

export type CoverageCounts = Record<CoverageStatus, number>;

export interface CoverageBucketData {
  label: string;
  total: number;
  counts: CoverageCounts;
}

// Exactly the MasteryDot classes (app/library/mastery-dot.tsx) so the app reads as one system.
const SEGMENT_CLASS: Record<CoverageStatus, string> = {
  unseen: "bg-neutral-300 dark:bg-neutral-700",
  learning: "bg-amber-400 dark:bg-amber-500",
  solid: "bg-sky-500 dark:bg-sky-400",
  mastered: "bg-emerald-500 dark:bg-emerald-400",
};

const STATUS_LABEL: Record<CoverageStatus, string> = {
  mastered: "Mastered",
  solid: "Solid",
  learning: "Learning",
  unseen: "Unseen",
};

// Left-to-right: strongest evidence first, unseen (least informative) trailing.
const STATUS_ORDER: CoverageStatus[] = ["mastered", "solid", "learning", "unseen"];

/** One shared legend for every bar below, so colors are only explained once. */
export function CoverageLegend() {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
      {STATUS_ORDER.map((status) => (
        <span key={status} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${SEGMENT_CLASS[status]}`} />
          {STATUS_LABEL[status]}
        </span>
      ))}
    </div>
  );
}

/**
 * Horizontal stacked bar for one kind+level bucket. Segments use flex-grow proportional to
 * count with a min-width floor so a tiny nonzero segment (e.g. 4 exposed items out of 670)
 * stays visible instead of rounding away to nothing.
 */
export function CoverageBar({ label, total, counts }: CoverageBucketData) {
  const touchedPct = total > 0 ? Math.round(((total - counts.unseen) / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
        <span className="shrink-0 text-neutral-400">
          {total.toLocaleString()} items · {touchedPct}% touched
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        {STATUS_ORDER.map((status) => {
          const count = counts[status];
          if (count === 0) return null;
          return (
            <div
              key={status}
              title={`${STATUS_LABEL[status]} — ${count.toLocaleString()} item${count === 1 ? "" : "s"}`}
              style={{ flexGrow: count, minWidth: "2px" }}
              className={SEGMENT_CLASS[status]}
            />
          );
        })}
      </div>
    </div>
  );
}
