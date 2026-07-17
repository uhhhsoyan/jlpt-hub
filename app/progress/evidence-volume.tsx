export interface EvidenceWeekData {
  /** ISO date (yyyy-mm-dd) of the Monday this ISO week starts on. */
  weekStart: string;
  total: number;
  bySource: Record<string, number>;
}

/**
 * Last 8 ISO weeks of observations, one small bar per week, height scaled to the busiest
 * week. Pure divs (no chart library); per-source breakdown lives in the title attribute.
 */
export function EvidenceVolume({ weeks }: { weeks: EvidenceWeekData[] }) {
  const hasAny = weeks.some((w) => w.total > 0);

  if (!hasAny) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
        No study evidence recorded yet.
      </p>
    );
  }

  const max = Math.max(1, ...weeks.map((w) => w.total));

  return (
    <div className="flex items-end gap-2">
      {weeks.map((week) => {
        const pct = week.total === 0 ? 0 : Math.max(4, Math.round((week.total / max) * 100));
        const bySourceText = Object.entries(week.bySource)
          .map(([source, n]) => `${source}: ${n}`)
          .join(", ");
        const title =
          week.total === 0
            ? `Week of ${week.weekStart}: no observations`
            : `Week of ${week.weekStart}: ${week.total} total (${bySourceText})`;

        return (
          <div key={week.weekStart} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-16 w-full items-end">
              <div
                title={title}
                style={{ height: `${pct}%` }}
                className="min-h-[2px] w-full rounded-t bg-sky-500 dark:bg-sky-400"
              />
            </div>
            <span className="text-[10px] text-neutral-400">{week.weekStart.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
