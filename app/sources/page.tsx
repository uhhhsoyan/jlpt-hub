import Link from "next/link";
import type { StudySourceRow } from "@/lib/db/schema";
import { SOURCE_KIND_ORDER } from "@/lib/study-sources";
import { EMPTY_STATS, getSourceStats, loadStudySources, type SourceStats } from "@/lib/study-sources-db";
import { STUDY_SOURCE_KIND_LABEL, type StudySourceKind } from "@/lib/types";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { SourceCard } from "./source-card";

// Reads the DB and the filesystem (public/sources) on every request; never prerendered.
export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; sources: StudySourceRow[]; stats: Map<string, SourceStats> }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function load(): Promise<DbState> {
  try {
    const [sources, stats] = await Promise.all([loadStudySources({ activeOnly: true }), getSourceStats()]);
    return { status: "ok", sources, stats };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

function groupByKind(sources: StudySourceRow[]): { kind: StudySourceKind; sources: StudySourceRow[] }[] {
  const groups = new Map<StudySourceKind, StudySourceRow[]>();
  for (const s of sources) {
    const list = groups.get(s.kind) ?? [];
    list.push(s);
    groups.set(s.kind, list);
  }
  const order = [...SOURCE_KIND_ORDER, ...[...groups.keys()].filter((k) => !SOURCE_KIND_ORDER.includes(k))];
  return order.filter((k) => groups.has(k)).map((kind) => ({ kind, sources: groups.get(kind)! }));
}

export default async function SourcesPage() {
  const db = await load();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight">Sources</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Every book, question bank and app the ledger draws on, and how much each has been used.{" "}
            <span className="text-neutral-400">教材。</span>
          </p>
        </div>
        <Link
          href="/sources/new"
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          Add source
        </Link>
      </header>

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code>, then run <code>npm run db:push</code> and{" "}
          <code>npm run db:seed-sources</code>.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the <code>study_sources</code> table doesn&apos;t exist yet. Run{" "}
          <code>npm run db:push</code>, then <code>npm run db:seed-sources</code>.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : db.sources.length === 0 ? (
        <Notice muted>
          No sources yet — run <code>npm run db:seed-sources</code> or add one above.
        </Notice>
      ) : (
        groupByKind(db.sources).map((group) => (
          <section key={group.kind} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                {STUDY_SOURCE_KIND_LABEL[group.kind]}
              </h2>
              <span className="text-xs text-neutral-400">{group.sources.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {group.sources.map((s) => (
                <SourceCard key={s.id} source={s} stats={db.stats.get(s.id) ?? EMPTY_STATS} />
              ))}
            </div>
          </section>
        ))
      )}
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
