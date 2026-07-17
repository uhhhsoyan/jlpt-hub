import { asc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { items, type ItemRow } from "@/lib/db/schema";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { LibraryView } from "./library-view";
import type { LibraryItem } from "./types";

export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; items: LibraryItem[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

function toLibraryItem(row: ItemRow): LibraryItem {
  const detail = row.detail;
  return {
    id: row.id,
    kind: row.kind === "kanji" ? "kanji" : "vocab",
    level: row.level,
    headword: row.headword,
    reading: row.reading,
    romaji: row.romaji,
    meaning: row.meaning,
    pos: detail?.pos ?? null,
    onyomi: detail?.onyomi ?? null,
    kunyomi: detail?.kunyomi ?? null,
  };
}

async function loadItems(): Promise<DbState> {
  try {
    const rows = await getDb()
      .select()
      .from(items)
      .where(inArray(items.kind, ["vocab", "kanji"]))
      .orderBy(asc(items.reading), asc(items.headword));
    return { status: "ok", items: rows.map(toLibraryItem) };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

export default async function LibraryPage() {
  const db = await loadItems();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Library</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Browse every N5/N4 vocab word and kanji in one place.{" "}
          <span className="text-neutral-400">辞書。</span>
        </p>
      </header>

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code>, then run{" "}
          <code>npm run db:push</code> and <code>npm run db:seed</code> to load the library.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the <code>items</code> table doesn&apos;t exist yet. Run{" "}
          <code>npm run db:push</code>, then <code>npm run db:seed</code>.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : db.items.length === 0 ? (
        <Notice muted>
          No items yet — run <code>npm run db:seed</code>.
        </Notice>
      ) : (
        <LibraryView items={db.items} />
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
