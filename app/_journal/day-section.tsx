import { dayDiff, dayParts, type FeedDay, type FeedDaySummary } from "@/lib/study-feed";
import { formatMinutes } from "@/app/sources/source-card";
import { InsightEntry, LooseWordsEntry, StudyEntry } from "./entries";
import { SessionEntry } from "./session-entry";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 sessions · 27 graded · 3 missed · closed book 4/6 · 8 words · 30 min", zero parts left out. */
export function summaryLine(s: FeedDaySummary): string {
  const parts: string[] = [];
  if (s.sessions > 0) parts.push(plural(s.sessions, "session"));
  if (s.graded > 0) parts.push(`${s.graded} graded`);
  if (s.misses > 0) parts.push(`${s.misses} missed`);
  if (s.closedBook) parts.push(`closed book ${s.closedBook.correct}/${s.closedBook.graded}`);
  if (s.words > 0) parts.push(plural(s.words, "word"));
  if (s.minutes > 0) parts.push(formatMinutes(s.minutes));
  if (s.insights > 0) parts.push(plural(s.insights, "insight"));
  return parts.join(" · ");
}

function relative(day: string, today: string): string | null {
  const d = dayDiff(day, today);
  return d === 0 ? "today" : d === 1 ? "yesterday" : null;
}

export function DaySection({ day, today }: { day: FeedDay; today: string }) {
  const { weekday, date } = dayParts(day.day);
  const rel = relative(day.day, today);
  return (
    <section aria-labelledby={`day-${day.day}`} className="flex flex-col gap-2.5">
      {/* Sticks under the nav (h-14) so a long day keeps its date in view on a phone. */}
      <div className="sticky top-14 z-[5] -mx-5 border-b border-neutral-200 bg-neutral-50/90 px-5 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        <h2 id={`day-${day.day}`} className="flex flex-wrap items-baseline gap-x-2 text-base font-bold tracking-tight">
          <span>{weekday}</span>
          <span className="font-semibold text-neutral-500 dark:text-neutral-400">{date}</span>
          {rel && <span className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">{rel}</span>}
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{summaryLine(day.summary)}</p>
      </div>
      {day.entries.map((e) => {
        switch (e.kind) {
          case "session":
            return <SessionEntry key={e.id} entry={e} />;
          case "study":
            return <StudyEntry key={e.id} entry={e} />;
          case "insight":
            return <InsightEntry key={e.id} entry={e} />;
          case "words":
            return <LooseWordsEntry key={`words-${e.label ?? ""}`} entry={e} />;
        }
      })}
    </section>
  );
}
