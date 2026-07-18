import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sprintSentences, items, clips, type ClipRow } from "@/lib/db/schema";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { Trainer } from "./trainer";
import type { SprintRow } from "./types";

export const dynamic = "force-dynamic";

type DbState =
  | { status: "ok"; rows: SprintRow[]; clips: ClipRow[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function loadChunk(chunk: number): Promise<DbState> {
  try {
    const db = getDb();
    const [rows, clipRows] = await Promise.all([
      db
        .select({
          id: sprintSentences.id,
          japanese: sprintSentences.japanese,
          reading: sprintSentences.reading,
          english: sprintSentences.english,
          audioPath: sprintSentences.audioPath,
          position: sprintSentences.position,
          itemId: items.id,
          headword: items.headword,
          itemReading: items.reading,
          meaning: items.meaning,
          level: items.level,
        })
        .from(sprintSentences)
        .innerJoin(items, eq(sprintSentences.itemId, items.id))
        .where(eq(sprintSentences.chunk, chunk))
        .orderBy(asc(sprintSentences.position)),
      db.select().from(clips).orderBy(desc(clips.createdAt)),
    ]);
    return { status: "ok", rows, clips: clipRows };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

export default async function SprintChunkPage({
  params,
}: {
  params: Promise<{ chunk: string }>;
}) {
  const { chunk: chunkParam } = await params;
  const chunk = Number(chunkParam);
  if (!Number.isInteger(chunk) || chunk < 0) notFound();

  const db = await loadChunk(chunk);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10 font-sans">
      <Link
        href="/sprint"
        className="w-fit text-sm text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300"
      >
        ← Sprint
      </Link>

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code> and run{" "}
          <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the sprint tables don&apos;t exist yet. Run{" "}
          <code>npm run db:push</code>, then reload.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : db.rows.length === 0 ? (
        <Notice muted>
          Deck {chunk + 1} is empty — it hasn&apos;t been generated, or the number is out of range.{" "}
          <Link href="/sprint" className="underline hover:text-neutral-600 dark:hover:text-neutral-300">
            Back to decks
          </Link>
          .
        </Notice>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-xl font-bold tracking-tight">Deck {chunk + 1}</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {db.rows.length} sentences · {db.rows.filter((r) => r.audioPath).length} with audio
            </p>
          </header>
          <Trainer chunk={chunk} rows={db.rows} clips={db.clips} />
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
