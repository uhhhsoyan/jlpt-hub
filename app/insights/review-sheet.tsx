import Link from "next/link";
import { shortDate } from "@/lib/study-feed";
import { insightsHref, type InsightsQuery, type SheetGroup } from "@/lib/insights-view";
import { journalDayHref } from "./insight-card";

/**
 * The selection as a compact review sheet: one section per grammar point (headword, reading,
 * meaning), its insights as plain paragraphs with the date and any other items they touch.
 * `data-print-sheet` switches on print.css, which drops the app frame and the page controls.
 */
export function ReviewSheet({ groups, query, title }: { groups: SheetGroup[]; query: InsightsQuery; title: string }) {
  return (
    <div data-print-sheet className="flex flex-col gap-6">
      <p className="hidden text-sm font-semibold print:block">{title}</p>
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`sheet-${g.key}`} className="flex flex-col gap-2 break-inside-avoid-page">
          <h2
            id={`sheet-${g.key}`}
            className="flex flex-wrap items-baseline gap-x-2 border-b border-neutral-200 pb-1 dark:border-neutral-800"
          >
            {g.query ? (
              <Link
                href={insightsHref({ ...g.query, view: query.view })}
                lang={g.kind === "item" ? "ja" : undefined}
                className="text-lg font-bold tracking-tight hover:underline"
              >
                {g.title}
              </Link>
            ) : (
              <span className="text-lg font-bold tracking-tight">{g.title}</span>
            )}
            {g.reading && (
              <span lang="ja" className="text-sm text-neutral-500 dark:text-neutral-400">
                {g.reading}
              </span>
            )}
            {g.meaning && <span className="text-sm text-neutral-600 dark:text-neutral-300">{g.meaning}</span>}
            {g.entries.length > 1 && <span className="text-xs tabular-nums text-neutral-400">· {g.entries.length} notes</span>}
          </h2>
          <ul className="flex flex-col gap-3">
            {g.entries.map(({ card, also }) => (
              <li key={card.id} className="break-inside-avoid border-l-2 border-neutral-200 pl-3 dark:border-neutral-700">
                <p className="whitespace-pre-line text-[15px] leading-relaxed text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-100">
                  {card.text}
                </p>
                <p className="mt-0.5 text-xs text-neutral-400">
                  <Link href={journalDayHref(card.day)} className="hover:underline">
                    {shortDate(card.day)}
                  </Link>
                  {also.length > 0 && (
                    <>
                      {" · also "}
                      <span lang="ja">{also.join("、")}</span>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
