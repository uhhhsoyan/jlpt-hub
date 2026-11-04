import Link from "next/link";
import { notFound } from "next/navigation";
import type { StudySourceRow } from "@/lib/db/schema";
import {
  EMPTY_STATS,
  getSourceStats,
  getStudySourceBySlug,
  listSourceSessions,
  listStudyLog,
  type SourceSession,
  type SourceStats,
  type StudyLogEntry,
} from "@/lib/study-sources-db";
import { STUDY_ACTIVITY_LABEL, STUDY_SOURCE_KIND_LABEL } from "@/lib/types";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { StatusBadge } from "@/app/practice/status-badge";
import { resolveSourceImage } from "../image";
import { SourceArt } from "../source-art";
import { formatMinutes, LevelBadge } from "../source-card";

export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; source: StudySourceRow; stats: SourceStats; sessions: SourceSession[]; log: StudyLogEntry[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string }
  | { status: "not_found" };

async function load(slug: string): Promise<DbState> {
  try {
    const source = await getStudySourceBySlug(slug);
    if (!source) return { status: "not_found" };
    const [stats, sessions, log] = await Promise.all([getSourceStats(), listSourceSessions(source.id), listStudyLog(source.id)]);
    return { status: "ok", source, stats: stats.get(source.id) ?? EMPTY_STATS, sessions, log };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

export default async function SourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await load(slug);
  if (db.status === "not_found") notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10 font-sans">
      <Link href="/sources" className="w-fit text-sm text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300">
        ← Sources
      </Link>

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code> and run <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the <code>study_sources</code> table doesn&apos;t exist yet. Run <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : (
        <SourceDetail source={db.source} stats={db.stats} sessions={db.sessions} log={db.log} />
      )}
    </div>
  );
}

function SourceDetail({
  source,
  stats,
  sessions,
  log,
}: {
  source: StudySourceRow;
  stats: SourceStats;
  sessions: SourceSession[];
  log: StudyLogEntry[];
}) {
  const imageSrc = resolveSourceImage(source.slug, source.imageUrl);
  return (
    <div className="flex flex-col gap-8">
      <header className="flex gap-5">
        <div className="w-28 shrink-0 sm:w-36">
          <SourceArt name={source.name} nameJa={source.nameJa} level={source.level} color={source.color} imageSrc={imageSrc} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight tracking-tight">{source.name}</h1>
              {source.nameJa && <p className="text-sm text-neutral-500 dark:text-neutral-400">{source.nameJa}</p>}
            </div>
            <Link
              href={`/sources/${source.slug}/edit`}
              className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Edit
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="uppercase tracking-wide text-neutral-400">{STUDY_SOURCE_KIND_LABEL[source.kind]}</span>
            <LevelBadge level={source.level} />
            {!source.active && (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                Inactive
              </span>
            )}
            {source.edition && <span>{source.edition}</span>}
            {source.url && (
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline dark:text-indigo-400">
                {new URL(source.url).hostname.replace(/^www\./, "")} ↗
              </a>
            )}
          </div>
          {source.description && <p className="text-sm text-neutral-700 dark:text-neutral-300">{source.description}</p>}
          {source.howUsed && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              <span className="font-medium text-neutral-600 dark:text-neutral-300">How it is used: </span>
              {source.howUsed}
            </p>
          )}
          {source.aliases.length > 0 && (
            <p className="text-xs text-neutral-400">
              Also logged as: {source.aliases.join(" · ")} · slug <code>{source.slug}</code>
            </p>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Practice" value={String(stats.practiceSessions)} sub={stats.lastSessionAt ? `last ${stats.lastSessionAt.slice(0, 10)}` : undefined} />
        <Stat label="Lessons" value={String(stats.lessonSessions)} />
        <Stat label="Study time" value={stats.minutes > 0 ? formatMinutes(stats.minutes) : "—"} sub={stats.logEntries > 0 ? `${stats.logEntries} entries` : undefined} />
        <Stat label="Last used" value={stats.lastUsedAt ? stats.lastUsedAt.slice(0, 10) : "—"} />
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Sessions</h2>
          {sessions.length > 0 && <span className="text-xs text-neutral-400">{sessions.length}</span>}
        </div>
        {sessions.length === 0 ? (
          <Notice muted>No sessions logged against this source yet.</Notice>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="min-w-0">
                  <Link href={`/practice/${s.id}`} className="block truncate text-[15px] leading-snug hover:underline">
                    {s.label}
                  </Link>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {s.takenAt.toISOString().slice(0, 10)}
                    {s.sourceName && <> · {s.sourceName}</>}
                    {s.mode === "lesson" && <> · open book</>}
                    {s.graded > 0 && (
                      <>
                        {" "}
                        · {s.correct}/{s.graded} ({Math.round((s.correct / s.graded) * 100)}%)
                      </>
                    )}
                  </p>
                </div>
                <StatusBadge status={s.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Study log</h2>
          {log.length > 0 && <span className="text-xs text-neutral-400">{log.length}</span>}
        </div>
        {log.length === 0 ? (
          <Notice muted>
            No time logged yet — <code>log_study</code> records reading, listening and review sessions here.
          </Notice>
        ) : (
          <ul className="flex flex-col gap-2">
            {log.map((e) => (
              <li
                key={e.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="min-w-0">
                  <p className="text-[15px] leading-snug">
                    {STUDY_ACTIVITY_LABEL[e.activity]}
                    {e.minutes != null && <span className="text-neutral-500 dark:text-neutral-400"> · {formatMinutes(e.minutes)}</span>}
                  </p>
                  {e.note && <p className="text-xs text-neutral-500 dark:text-neutral-400">{e.note}</p>}
                </div>
                <span className="shrink-0 text-xs text-neutral-400">{e.takenAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</span>
      <span className="text-lg font-bold leading-tight">{value}</span>
      {sub && <span className="text-[11px] text-neutral-400">{sub}</span>}
    </div>
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
