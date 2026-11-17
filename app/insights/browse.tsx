import Link from "next/link";
import {
  hasTag,
  insightsHref,
  parseLessonTag,
  withTag,
  withoutTag,
  type InsightsPage,
  type InsightsQuery,
  type ItemIndexEntry,
  type LessonSeries,
  type TagCount,
} from "@/lib/insights-view";

/** A lesson replaces any other lesson of its series (L12 then L13 switches); a second click clears it. */
function lessonHref(query: InsightsQuery, series: string, tag: string): string {
  if (hasTag(query, tag)) return insightsHref(withoutTag(query, tag));
  const others = query.tags.filter((t) => parseLessonTag(t)?.series !== series);
  return insightsHref({ ...query, tags: [...others, tag] });
}

/** A topic tag joins the AND-filter; a second click takes it out. */
function topicHref(query: InsightsQuery, tag: string): string {
  return insightsHref(hasTag(query, tag) ? withoutTag(query, tag) : withTag(query, tag));
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">{children}</h2>;
}

function LessonStrip({ series, query }: { series: LessonSeries; query: InsightsQuery }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">{series.label} lessons</p>
      <ul className="flex flex-wrap gap-1">
        {series.lessons.map((l) => {
          const active = hasTag(query, l.tag);
          return (
            <li key={l.tag}>
              <Link
                href={lessonHref(query, series.series, l.tag)}
                aria-current={active ? "true" : undefined}
                title={`#${l.tag}: ${l.n} insight${l.n === 1 ? "" : "s"}`}
                className={`flex min-h-10 min-w-10 flex-col items-center justify-center rounded-lg border px-1.5 leading-none transition ${
                  active
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                }`}
              >
                <span className="text-sm font-bold tabular-nums">{l.lesson}</span>
                <span className={`mt-0.5 text-[10px] tabular-nums ${active ? "text-indigo-100" : "text-neutral-400"}`}>{l.n}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TagLinks({ tags, query }: { tags: TagCount[]; query: InsightsQuery }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {tags.map((t) => {
        const active = hasTag(query, t.tag);
        return (
          <li key={t.tag}>
            <Link
              href={topicHref(query, t.tag)}
              aria-current={active ? "true" : undefined}
              className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition ${
                active
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300"
              }`}
            >
              {t.tag}
              <span className={`tabular-nums ${active ? "text-indigo-100" : "text-neutral-400"}`}>{t.n}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ItemIndex({ entries, query, activeIds }: { entries: ItemIndexEntry[]; query: InsightsQuery; activeIds: string[] }) {
  return (
    <ol className="-mx-2 flex flex-col">
      {entries.map((e) => {
        const active = query.item === e.param || activeIds.includes(e.param);
        return (
          <li key={e.param}>
            <Link
              href={insightsHref(active ? { view: query.view } : { item: e.param, view: query.view })}
              aria-current={active ? "true" : undefined}
              className={`flex min-h-10 items-baseline gap-2 rounded-lg px-2 py-1.5 transition ${
                active ? "bg-indigo-50 dark:bg-indigo-950/60" : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
              }`}
            >
              <span lang="ja" className={`shrink-0 text-[15px] font-medium ${e.linked ? "text-neutral-900 dark:text-neutral-50" : "text-neutral-500"}`}>
                {e.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">{e.meaning ?? ""}</span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-neutral-500 dark:text-neutral-400">{e.n}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Ways into the set: the items that keep coming up, lesson strips, then topic tags by count
 * with the long tail folded. Counts cover every insight, whatever is filtered.
 */
export function BrowsePanel({ page }: { page: InsightsPage }) {
  const { query, tagGroups, itemIndex } = page;
  // Keep an active long-tail tag visible without opening "more".
  const moreOpen = tagGroups.more.some((t) => hasTag(query, t.tag));
  return (
    <div className="flex flex-col gap-6">
      {tagGroups.series.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionLabel>By lesson</SectionLabel>
          {tagGroups.series.map((s) => (
            <LessonStrip key={s.series} series={s} query={query} />
          ))}
        </section>
      )}
      {itemIndex.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <SectionLabel>Keeps coming up</SectionLabel>
          <ItemIndex entries={itemIndex} query={query} activeIds={page.activeItem?.ids ?? []} />
        </section>
      )}
      {tagGroups.topics.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>By topic</SectionLabel>
          <TagLinks tags={tagGroups.topics} query={query} />
          {tagGroups.more.length > 0 && (
            <details open={moreOpen} className="group">
              <summary className="inline-flex min-h-8 cursor-pointer items-center text-xs font-semibold text-indigo-600 select-none dark:text-indigo-400">
                <span className="group-open:hidden">{tagGroups.more.length} more tags</span>
                <span className="hidden group-open:inline">Fewer tags</span>
              </summary>
              <div className="mt-1.5">
                <TagLinks tags={tagGroups.more} query={query} />
              </div>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
