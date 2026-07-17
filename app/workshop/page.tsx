import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sentences, type SentenceRow } from "@/lib/db/schema";
import { Workshop } from "./workshop-form";
import { LevelBadge } from "./level-badge";
import { remove } from "./actions";
import { errChain, firstLine } from "./db-error";

export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; rows: SentenceRow[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function loadSaved(): Promise<DbState> {
  try {
    const rows = await getDb().select().from(sentences).orderBy(desc(sentences.createdAt));
    return { status: "ok", rows };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

export default async function WorkshopPage() {
  const db = await loadSaved();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Sentence Workshop</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Turn everyday English into JLPT&nbsp;N4 Japanese, with the faithful version and a level
          breakdown. <span className="text-neutral-400">文を作ろう。</span>
        </p>
      </header>

      <Workshop />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
            My sentences
          </h2>
          {db.status === "ok" && db.rows.length > 0 && (
            <span className="text-xs text-neutral-400">{db.rows.length} saved</span>
          )}
        </div>

        {db.status === "missing_url" ? (
          <Notice>
            Generation works now. To <b>save</b> sentences, add <code>DATABASE_URL</code> to{" "}
            <code>.env.local</code> and run <code>npm run db:push</code> (see SETUP.md).
          </Notice>
        ) : db.status === "missing_table" ? (
          <Notice>
            Database connected, but the table doesn&apos;t exist yet. Run{" "}
            <code>npm run db:push</code> to create it, then reload.
          </Notice>
        ) : db.status === "error" ? (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            Couldn&apos;t read the database: {db.detail}
          </p>
        ) : db.rows.length === 0 ? (
          <Notice muted>Nothing saved yet. Generate a sentence and hit save.</Notice>
        ) : (
          <ul className="flex flex-col gap-3">
            {db.rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-1 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-lg leading-snug">{row.n4Japanese}</p>
                  <form action={remove.bind(null, row.id)}>
                    <button
                      type="submit"
                      className="shrink-0 text-xs text-neutral-400 transition hover:text-red-600"
                      aria-label="Delete sentence"
                    >
                      Delete
                    </button>
                  </form>
                </div>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{row.n4Reading}</p>
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  <span className="text-neutral-400">EN&nbsp;</span>
                  {row.englishInput}
                </p>
                {row.faithfulDiffers && (
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-neutral-500">
                    <LevelBadge level={row.faithfulLevelTag} />
                    <span>{row.faithfulJapanese}</span>
                  </p>
                )}
                <span className="mt-1 text-[11px] text-neutral-300 dark:text-neutral-600">
                  {row.createdAt.toISOString().slice(0, 10)}
                </span>
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
