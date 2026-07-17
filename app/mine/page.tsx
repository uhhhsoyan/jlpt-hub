import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { clips, type ClipRow } from "@/lib/db/schema";
import { MineForm } from "./mine-form";
import { removeClip } from "./actions";
import { errChain, firstLine } from "@/app/workshop/db-error";

export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; rows: ClipRow[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function loadClips(): Promise<DbState> {
  try {
    const rows = await getDb().select().from(clips).orderBy(desc(clips.createdAt));
    return { status: "ok", rows };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01/i.test(s)) return { status: "missing_table" };
    return { status: "error", detail: firstLine(s) };
  }
}

export default async function MinePage() {
  const db = await loadClips();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Listening Mine</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Pull sentence-level audio clips out of a YouTube video, pair them with text, and drill
          listening. <span className="text-neutral-400">聞き取り。</span>
        </p>
      </header>

      <MineForm />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">My clips</h2>
          {db.status === "ok" && db.rows.length > 0 && (
            <span className="text-xs text-neutral-400">{db.rows.length} saved</span>
          )}
        </div>

        {db.status === "missing_url" ? (
          <Notice>
            Add <code>DATABASE_URL</code> to <code>.env.local</code> and run <code>npm run db:push</code> to
            save clips.
          </Notice>
        ) : db.status === "missing_table" ? (
          <Notice>
            Database connected, but the <code>clips</code> table doesn&apos;t exist yet. Run{" "}
            <code>npm run db:push</code>, then reload.
          </Notice>
        ) : db.status === "error" ? (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            Couldn&apos;t read the database: {db.detail}
          </p>
        ) : db.rows.length === 0 ? (
          <Notice muted>No clips yet. Mine a video above and save the good ones.</Notice>
        ) : (
          <ul className="flex flex-col gap-3">
            {db.rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-lg leading-snug">{row.japanese}</p>
                  <form action={removeClip.bind(null, row.id, row.audioUrl)}>
                    <button
                      type="submit"
                      className="shrink-0 text-xs text-neutral-400 transition hover:text-red-600"
                      aria-label="Delete clip"
                    >
                      Delete
                    </button>
                  </form>
                </div>
                <audio controls preload="none" src={row.audioUrl} className="h-8 w-full max-w-sm" />
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-neutral-400 transition hover:text-indigo-500"
                >
                  {row.sourceLabel ? `${row.sourceLabel} · ` : ""}source ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
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
