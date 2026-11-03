import { rootCauseLabel, type PracticeSection } from "@/lib/types";
import type { RootCauseMisses, SectionAccuracy } from "@/lib/weakness";

const SECTION_LABEL: Record<PracticeSection, string> = {
  kanji: "Kanji",
  vocab: "Vocab",
  grammar: "Grammar",
  reading: "Reading",
  listening: "Listening",
  other: "Other",
};

function causeLabel(cause: string): string {
  return cause === "unclassified" ? "Unclassified" : rootCauseLabel(cause);
}

export interface RootCausesData {
  /** Trailing 14 days. */
  recent: RootCauseMisses[];
  /** Trailing 30 days. */
  month: RootCauseMisses[];
  sections: SectionAccuracy[];
}

/**
 * Why questions are being missed, not just which: misses by root cause over the last
 * 14 and 30 days, then accuracy per exam section over 30 days. Same queries the MCP
 * get_weakness_report tool runs, so the page and the tool never disagree.
 */
export function RootCauses({ data }: { data: RootCausesData }) {
  const recent = new Map(data.recent.map((r) => [r.rootCause, r.misses]));
  const causes = data.month.map((row) => ({
    cause: row.rootCause,
    known: row.known,
    month: row.misses,
    recent: recent.get(row.rootCause) ?? 0,
  }));
  const maxMonth = Math.max(1, ...causes.map((c) => c.month));
  const totalMonth = causes.reduce((s, c) => s + c.month, 0);

  if (causes.length === 0 && data.sections.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
        No confirmed practice in the last 30 days. Log a page from the claude.ai project or upload one above.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {causes.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            <span>Misses by cause</span>
            <span className="text-right tabular-nums">14d</span>
            <span className="text-right tabular-nums">30d</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {causes.map((c) => (
              <li key={c.cause} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 text-sm">
                <div className="flex min-w-0 flex-col gap-1">
                  <span
                    className={
                      c.cause === "unclassified"
                        ? "text-neutral-400 dark:text-neutral-500"
                        : "text-neutral-700 dark:text-neutral-300"
                    }
                  >
                    {causeLabel(c.cause)}
                    {!c.known && c.cause !== "unclassified" && (
                      <span className="ml-1.5 rounded bg-neutral-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:bg-neutral-800">
                        custom
                      </span>
                    )}
                  </span>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                    <div
                      style={{ width: `${Math.max(2, Math.round((c.month / maxMonth) * 100))}%` }}
                      className={c.cause === "unclassified" ? "h-full bg-neutral-300 dark:bg-neutral-600" : "h-full bg-rose-400 dark:bg-rose-500"}
                    />
                  </div>
                </div>
                <span className="w-8 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{c.recent}</span>
                <span className="w-8 text-right font-semibold tabular-nums text-neutral-700 dark:text-neutral-200">{c.month}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-400">
            {totalMonth} miss{totalMonth === 1 ? "" : "es"} in 30 days across confirmed sessions.
          </p>
        </div>
      )}

      {data.sections.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Accuracy by section, 30d</span>
          <ul className="flex flex-wrap gap-2">
            {data.sections.map((s) => {
              const pct = Math.round(s.accuracy * 100);
              const tone =
                pct >= 85
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : pct >= 65
                    ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                    : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300";
              return (
                <li key={s.section} className={`flex items-baseline gap-2 rounded-lg border px-3 py-1.5 text-sm ${tone}`}>
                  <span className="font-medium">{SECTION_LABEL[s.section]}</span>
                  <span className="font-semibold tabular-nums">{pct}%</span>
                  <span className="text-xs opacity-70 tabular-nums">
                    {s.correct}/{s.graded}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
