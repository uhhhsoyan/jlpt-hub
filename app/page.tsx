import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { loadStudyFeed } from "@/lib/study-feed-db";
import { addDays, dayDiff, FEED_DAYS, isFiltered, NO_FILTER, parseDay, parseFeedFilter, shortDate, type StudyFeed } from "@/lib/study-feed";
import { syncWanikaniIfStale } from "@/lib/wanikani";
import { syncBunproIfStale } from "@/lib/bunpro";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { DaySection } from "./_journal/day-section";
import { JournalFilters } from "./_journal/filters";
import { journalHref } from "./_journal/href";

// Reads the DB on every request (and searchParams); never prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Journal · JLPT Hub" };

/** Exam day (JLPT N4, US administration); the full countdown lives on /schedule and /progress. */
const EXAM_DAY = "2026-12-06";

type DbState =
  | { status: "ok"; feed: StudyFeed }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function load(to: string | null, filter: ReturnType<typeof parseFeedFilter>): Promise<DbState> {
  try {
    return { status: "ok", feed: await loadStudyFeed({ to, filter }) };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) return { status: "missing_table" };
    return { status: "error", detail: firstLine(s) };
  }
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function JournalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter = parseFeedFilter(params);
  const toParam = parseDay(Array.isArray(params.to) ? params.to[0] : params.to);
  const db = await load(toParam, filter);
  // Refresh integrations in the background when their snapshots are over an hour old; runs
  // after the response is sent, so opening the app stays instant (moved here with the home page).
  after(() => Promise.all([syncWanikaniIfStale(), syncBunproIfStale()]));

  const today = db.status === "ok" ? db.feed.today : null;
  const daysToExam = today ? dayDiff(today, EXAM_DAY) : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-8 font-sans">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-bold tracking-tight">Journal</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              What you studied, where you got stuck, what you took from it. <span className="text-neutral-400">日記。</span>
            </p>
          </div>
          {daysToExam !== null && daysToExam >= 0 && (
            <Link
              href="/schedule"
              className="shrink-0 rounded-xl bg-indigo-50 px-3 py-1.5 text-right transition hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-950"
            >
              <span className="block text-lg font-bold leading-none text-indigo-600 dark:text-indigo-300">{daysToExam}</span>
              <span className="block text-[10px] uppercase tracking-wide text-neutral-500">days to N4</span>
            </Link>
          )}
        </div>
        {db.status === "ok" && <JournalFilters to={toParam && toParam < db.feed.today ? toParam : null} filter={filter} sources={db.feed.sources} />}
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
      ) : (
        <Feed feed={db.feed} />
      )}
    </div>
  );
}

function Feed({ feed }: { feed: StudyFeed }) {
  const { window: w, today, filter } = feed;
  const range = `${shortDate(w.from)} – ${shortDate(w.to)}`;
  const newerTo = w.to < today ? addDays(w.to, FEED_DAYS) : null;
  const newerHref = newerTo ? journalHref({ to: newerTo < today ? newerTo : null, filter }) : null;
  const olderHref = feed.older ? journalHref({ to: feed.older, filter }) : null;

  return (
    <>
      {feed.days.length === 0 ? (
        <EmptyState feed={feed} range={range} />
      ) : (
        <div className="flex flex-col gap-7">
          {feed.days.map((d) => (
            <DaySection key={d.day} day={d} today={today} />
          ))}
        </div>
      )}

      {(olderHref || newerHref || feed.days.length > 0) && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-neutral-200 pt-4 text-sm dark:border-neutral-800">
          {newerHref ? (
            <Link href={newerHref} className="inline-flex min-h-10 items-center font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-neutral-400">{range}</span>
          {olderHref ? (
            <Link href={olderHref} className="inline-flex min-h-10 items-center font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}

function EmptyState({ feed, range }: { feed: StudyFeed; range: string }) {
  if (feed.windowHasRows && isFiltered(feed.filter)) {
    return (
      <Notice muted>
        Nothing in {range} matches these filters.{" "}
        <Link href={journalHref({ to: feed.window.to < feed.today ? feed.window.to : null, filter: NO_FILTER })} className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
          Clear filters
        </Link>
      </Notice>
    );
  }
  if (!feed.older && feed.window.to === feed.today) {
    return (
      <Notice muted>
        Nothing logged yet. Sessions, study time, insights and words you didn&apos;t know, logged from claude.ai, show up here one day at a
        time.
      </Notice>
    );
  }
  return <Notice muted>Nothing logged {range}.</Notice>;
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
