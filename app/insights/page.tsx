import type { Metadata } from "next";
import Link from "next/link";
import { loadInsightsPage } from "@/lib/insights-db";
import { insightsHref, isFiltered, parseInsightsQuery, withoutTag, type InsightsPage, type InsightsQuery } from "@/lib/insights-view";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { BrowsePanel } from "./browse";
import { InsightCard } from "./insight-card";
import { ReviewSheet } from "./review-sheet";
import "./print.css";

// Reads the DB on every request (and searchParams); never prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Insights · JLPT Hub" };

type DbState =
  | { status: "ok"; page: InsightsPage }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function load(query: InsightsQuery): Promise<DbState> {
  try {
    return { status: "ok", page: await loadInsightsPage(query) };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) return { status: "missing_table" };
    return { status: "error", detail: firstLine(s) };
  }
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function InsightsRoute({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = parseInsightsQuery(await searchParams);
  const db = await load(query);
  const page = db.status === "ok" ? db.page : null;

  return (
    <div data-print-page className="mx-auto w-full max-w-2xl px-5 py-8 font-sans xl:grid xl:max-w-6xl xl:grid-cols-[minmax(0,1fr)_17rem] xl:gap-10">
      <div className="flex min-w-0 flex-col gap-5">
        <header data-print-hide className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight">Insights</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Pro tips, recurring confusions and test cues from your study, in one place. <span className="text-neutral-400">気づき。</span>
          </p>
        </header>

        {db.status === "missing_url" ? (
          <Notice>
            Add <code>DATABASE_URL</code> to <code>.env.local</code> and run <code>npm run db:push</code> (see SETUP.md).
          </Notice>
        ) : db.status === "missing_table" ? (
          <Notice>
            Database connected, but the ledger tables don&apos;t exist yet. Run <code>npm run db:push</code>, then reload.
          </Notice>
        ) : db.status === "error" ? (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            Couldn&apos;t read the database: {db.detail}
          </p>
        ) : page && page.total === 0 ? (
          <Notice muted>
            No insights yet. Pro tips, recurring confusions and test cues logged from claude.ai land here, ready to filter by lesson,
            topic or grammar point.
          </Notice>
        ) : page ? (
          <Selection page={page} />
        ) : null}
      </div>

      {page && page.total > 0 && (
        <aside aria-label="Browse insights" data-print-hide className="hidden xl:block">
          <div className="sticky top-[calc(var(--app-topbar-h)+2rem)] max-h-[calc(100vh-4rem)] overflow-y-auto pb-4 pr-1">
            <BrowsePanel page={page} />
          </div>
        </aside>
      )}
    </div>
  );
}

function Selection({ page }: { page: InsightsPage }) {
  const { query, cards, total } = page;
  const filtered = isFiltered(query);
  const sheet = query.view === "sheet";

  return (
    <>
      <div data-print-hide className="flex flex-col gap-3">
        <SearchForm query={query} />
        {filtered && <ActiveFilters page={page} />}
        {/* Below xl the browse panel folds into a disclosure above the list. */}
        <details className="group rounded-xl border border-neutral-200 bg-white xl:hidden dark:border-neutral-800 dark:bg-neutral-900">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
            Browse by lesson, topic or item
            <span aria-hidden className="text-neutral-400 transition group-open:rotate-180">
              ▾
            </span>
          </summary>
          <div className="border-t border-neutral-100 px-4 pt-3 pb-4 dark:border-neutral-800">
            <BrowsePanel page={page} />
          </div>
        </details>
      </div>

      {/* Sticks under the mobile top bar (top of the viewport on desktop), like the journal's day headers. */}
      <div
        data-print-hide
        className="sticky top-(--app-topbar-h) z-[5] -mx-5 flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50/90 px-5 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90"
      >
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {filtered ? (
            <>
              <span className="font-semibold text-neutral-900 tabular-nums dark:text-neutral-50">{cards.length}</span> of{" "}
              <span className="tabular-nums">{total}</span>
              <Link href={insightsHref({ view: query.view })} className="ml-3 font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                Reset
              </Link>
            </>
          ) : (
            <>
              <span className="font-semibold text-neutral-900 tabular-nums dark:text-neutral-50">{total}</span> insights, newest first
            </>
          )}
        </p>
        <nav aria-label="View" className="flex shrink-0 items-center gap-0.5 rounded-lg bg-neutral-200/60 p-0.5 dark:bg-neutral-800">
          <Link href={insightsHref({ ...query, view: "list" })} aria-current={!sheet ? "page" : undefined} className={viewPill(!sheet)}>
            Cards
          </Link>
          <Link href={insightsHref({ ...query, view: "sheet" })} aria-current={sheet ? "page" : undefined} className={viewPill(sheet)}>
            Review sheet
          </Link>
        </nav>
      </div>

      {cards.length === 0 ? (
        <Notice muted>
          Nothing matches these filters.{" "}
          <Link href={insightsHref({ view: query.view })} className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
            Reset
          </Link>
        </Notice>
      ) : sheet && page.sheet ? (
        <>
          <p data-print-hide className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            Grouped by grammar point. Print or save as PDF for a one-glance review before a test.
          </p>
          <ReviewSheet groups={page.sheet} query={query} title={sheetTitle(page)} />
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((c) => (
            <InsightCard key={c.id} card={c} query={query} />
          ))}
        </div>
      )}
    </>
  );
}

function viewPill(active: boolean): string {
  return `inline-flex min-h-8 items-center rounded-md px-2.5 text-xs font-semibold transition ${
    active ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-50" : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200"
  }`;
}

/** "Insights · #skm-l12 · “はず”" for the printed sheet's heading. */
function sheetTitle(page: InsightsPage): string {
  const { query, activeItem } = page;
  const parts = [...query.tags.map((t) => `#${t}`), ...(activeItem ? [activeItem.label] : []), ...(query.q ? [`“${query.q}”`] : [])];
  return ["Insights", ...parts].join(" · ") + ` (${page.cards.length})`;
}

function SearchForm({ query }: { query: InsightsQuery }) {
  // A plain GET form: the search lands in the URL with the other filters, server-rendered.
  return (
    <form action="/insights" method="get" role="search" className="flex gap-2">
      <label htmlFor="insights-q" className="sr-only">
        Search insights
      </label>
      <input
        id="insights-q"
        name="q"
        type="search"
        defaultValue={query.q ?? ""}
        placeholder="はず, polarity, cue…"
        className="min-h-11 min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white px-3.5 text-base placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-neutral-700 dark:bg-neutral-900"
      />
      {query.tags.map((t) => (
        <input key={t} type="hidden" name="tag" value={t} />
      ))}
      {query.item && <input type="hidden" name="item" value={query.item} />}
      {query.view === "sheet" && <input type="hidden" name="view" value="sheet" />}
      <button
        type="submit"
        className="min-h-11 shrink-0 rounded-xl bg-neutral-900 px-4 text-sm font-semibold text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Search
      </button>
    </form>
  );
}

function ActiveFilters({ page }: { page: InsightsPage }) {
  const { query, activeItem } = page;
  return (
    <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
      {query.q && (
        <li>
          <RemovableChip href={insightsHref({ ...query, q: null })} label={`Remove search ${query.q}`}>
            <span className="text-indigo-200">search</span> <span lang="ja">{query.q}</span>
          </RemovableChip>
        </li>
      )}
      {activeItem && (
        <li>
          <RemovableChip href={insightsHref({ ...query, item: null })} label={`Remove item ${activeItem.label}`}>
            <span lang="ja">{activeItem.label}</span>
            {activeItem.meaning && <span className="text-indigo-200"> · {activeItem.meaning}</span>}
          </RemovableChip>
        </li>
      )}
      {query.tags.map((t) => (
        <li key={t}>
          <RemovableChip href={insightsHref(withoutTag(query, t))} label={`Remove tag ${t}`}>
            #{t}
          </RemovableChip>
        </li>
      ))}
    </ul>
  );
}

function RemovableChip({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-indigo-600 py-1 pr-2 pl-3 text-xs font-medium text-white transition hover:bg-indigo-700"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <span aria-hidden className="text-sm leading-none text-indigo-200">
        ×
      </span>
    </Link>
  );
}

function Notice({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <p
      className={`rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm dark:border-neutral-700 ${
        muted ? "text-neutral-400" : "text-neutral-500"
      }`}
    >
      {children}
    </p>
  );
}
