import Link from "next/link";
import type { VocabQueueRow } from "@/lib/db/schema";
import { countVocabQueue, listVocabQueue, type QueueCounts, type QueueFilter } from "@/lib/vocab-queue";
import { isVocabQueueStatus, VOCAB_QUEUE_STATUS_LABEL, VOCAB_QUEUE_STATUSES, type VocabQueueStatus } from "@/lib/types";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { markAllQueuedCarded, setStatus } from "./actions";

export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; rows: VocabQueueRow[]; counts: QueueCounts }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function load(filter: QueueFilter): Promise<DbState> {
  try {
    const [rows, counts] = await Promise.all([listVocabQueue({ status: filter, limit: 500 }), countVocabQueue()]);
    return { status: "ok", rows, counts };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) return { status: "missing_table" };
    return { status: "error", detail: firstLine(s) };
  }
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Buttons a row offers depend on where it is; the current status is never offered. */
const NEXT: Record<VocabQueueStatus, { status: VocabQueueStatus; label: string }[]> = {
  queued: [
    { status: "carded", label: "Carded" },
    { status: "known", label: "Known" },
    { status: "skipped", label: "Skip" },
  ],
  carded: [{ status: "queued", label: "Requeue" }],
  known: [{ status: "queued", label: "Requeue" }],
  skipped: [
    { status: "queued", label: "Requeue" },
    { status: "known", label: "Known" },
  ],
};

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: raw } = await searchParams;
  const filter: QueueFilter = raw === "all" || (raw && isVocabQueueStatus(raw)) ? (raw as QueueFilter) : "queued";
  const db = await load(filter);
  const total = db.status === "ok" ? Object.values(db.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Vocab queue</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Every word you said you didn&apos;t know, wherever it came up. Review, export to Anki, mark as carded.{" "}
          <span className="text-neutral-400">知らなかった言葉。</span>
        </p>
      </header>

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code>, then run <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the <code>vocab_queue</code> table doesn&apos;t exist yet. Run <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav className="flex flex-wrap gap-1 text-sm">
              {[...VOCAB_QUEUE_STATUSES, "all" as const].map((s) => {
                const active = s === filter;
                const n = s === "all" ? total : db.counts[s];
                return (
                  <Link
                    key={s}
                    href={s === "queued" ? "/queue" : `/queue?status=${s}`}
                    className={`rounded-lg px-3 py-1.5 font-semibold transition ${
                      active
                        ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                        : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200"
                    }`}
                  >
                    {s === "all" ? "All" : VOCAB_QUEUE_STATUS_LABEL[s]} <span className="font-normal opacity-60">{n}</span>
                  </Link>
                );
              })}
            </nav>
            {filter === "queued" && db.counts.queued > 0 ? (
              <div className="flex items-center gap-2">
                <a
                  href="/queue/export?status=queued"
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500"
                >
                  Export Anki TSV
                </a>
                <form action={markAllQueuedCarded}>
                  <button
                    type="submit"
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-semibold text-neutral-700 transition hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
                  >
                    Mark all carded
                  </button>
                </form>
              </div>
            ) : null}
          </div>

          {db.rows.length === 0 ? (
            <Notice muted>
              Nothing {filter === "all" ? "in the queue" : VOCAB_QUEUE_STATUS_LABEL[filter].toLowerCase()} yet. Words land here when
              a logged attempt carries <code>vocab_gaps</code>, or through the <code>queue_vocab</code> tool.
            </Notice>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
              {db.rows.map((r) => {
                const latest = r.sightings[r.sightings.length - 1];
                return (
                  <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-lg font-semibold">{r.text}</span>
                        {r.reading && r.reading !== r.text ? <span className="text-sm text-neutral-500">{r.reading}</span> : null}
                        {r.meaning ? <span className="text-sm text-neutral-600 dark:text-neutral-300">{r.meaning}</span> : null}
                        {r.itemId ? (
                          <span title="Linked to a library item" className="text-xs text-emerald-600 dark:text-emerald-400">
                            ● library
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-neutral-400">
                        {filter === "all" ? `${VOCAB_QUEUE_STATUS_LABEL[r.status]} · ` : ""}
                        seen {r.seenCount}× · last {day(r.lastSeenAt)}
                        {latest?.label ? ` · ${latest.label}` : ""}
                      </div>
                      {latest?.context ? (
                        <div className="truncate text-sm text-neutral-500 dark:text-neutral-400" title={latest.context}>
                          {latest.context}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {NEXT[r.status].map((n) => (
                        <form key={n.status} action={setStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value={n.status} />
                          <button
                            type="submit"
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-semibold text-neutral-600 transition hover:border-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-white"
                          >
                            {n.label}
                          </button>
                        </form>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
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
