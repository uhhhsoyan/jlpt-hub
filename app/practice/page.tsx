import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { practiceSessions, type PracticeSessionRow } from "@/lib/db/schema";
import { getWeakItems, type WeakItem } from "@/lib/weakness";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { NewSessionForm } from "./new-session-form";
import { StatusBadge } from "./status-badge";
import { WeakPointsPanel } from "./weak-points-panel";
import { deleteSession } from "./actions";

export const dynamic = "force-dynamic";

interface SessionSummary {
  id: string;
  label: string;
  sourceName: string | null;
  status: PracticeSessionRow["status"];
  takenAt: Date;
  graded: number;
  correct: number;
}

type DbState =
  | { status: "ok"; sessions: SessionSummary[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

type ScoreRow = Record<string, unknown> & {
  session_id: string;
  graded: string | number;
  correct: string | number;
};

async function loadSessions(): Promise<DbState> {
  try {
    const db = getDb();
    const [rows, scoreRes] = await Promise.all([
      db.select().from(practiceSessions).orderBy(desc(practiceSessions.takenAt)),
      db.execute<ScoreRow>(sql`
        SELECT session_id,
               count(*) FILTER (WHERE is_correct IS NOT NULL) AS graded,
               count(*) FILTER (WHERE is_correct) AS correct
        FROM practice_questions
        GROUP BY session_id
      `),
    ]);

    const scores = new Map(
      scoreRes.rows.map((r) => [r.session_id, { graded: Number(r.graded), correct: Number(r.correct) }]),
    );
    const sessions = rows.map((r) => ({
      id: r.id,
      label: r.label,
      sourceName: r.sourceName,
      status: r.status,
      takenAt: r.takenAt,
      graded: scores.get(r.id)?.graded ?? 0,
      correct: scores.get(r.id)?.correct ?? 0,
    }));
    return { status: "ok", sessions };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

async function loadWeakItems(): Promise<WeakItem[]> {
  try {
    return await getWeakItems();
  } catch {
    return [];
  }
}

export default async function PracticePage() {
  const [db, weakItems] = await Promise.all([loadSessions(), loadWeakItems()]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Practice</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Photograph completed workbook pages — Claude reads and grades them, you confirm, and the
          results feed your mastery scores. <span className="text-neutral-400">練習。</span>
        </p>
      </header>

      <NewSessionForm />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Sessions</h2>
          {db.status === "ok" && db.sessions.length > 0 && (
            <span className="text-xs text-neutral-400">{db.sessions.length}</span>
          )}
        </div>

        {db.status === "missing_url" ? (
          <Notice>
            Add <code>DATABASE_URL</code> to <code>.env.local</code> and run{" "}
            <code>npm run db:push</code> (see SETUP.md).
          </Notice>
        ) : db.status === "missing_table" ? (
          <Notice>
            Database connected, but the practice tables don&apos;t exist yet. Run{" "}
            <code>npm run db:push</code>, then reload.
          </Notice>
        ) : db.status === "error" ? (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            Couldn&apos;t read the database: {db.detail}
          </p>
        ) : db.sessions.length === 0 ? (
          <Notice muted>No sessions yet — upload photos of a completed practice page above.</Notice>
        ) : (
          <ul className="flex flex-col gap-3">
            {db.sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-col gap-1 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/practice/${session.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-lg leading-snug hover:underline">{session.label}</p>
                  </Link>
                  <StatusBadge status={session.status} />
                </div>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {session.sourceName && <>{session.sourceName} · </>}
                  {session.takenAt.toISOString().slice(0, 10)}
                  {session.graded > 0 && (
                    <>
                      {" "}
                      · {session.correct}/{session.graded} (
                      {Math.round((session.correct / session.graded) * 100)}%)
                    </>
                  )}
                </p>
                <div className="mt-1 flex items-center gap-3">
                  <Link
                    href={`/practice/${session.id}`}
                    className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    View
                  </Link>
                  <form action={deleteSession.bind(null, session.id)}>
                    <button
                      type="submit"
                      className="text-xs text-neutral-400 transition hover:text-red-600"
                      aria-label="Delete session"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <WeakPointsPanel items={weakItems} />
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
