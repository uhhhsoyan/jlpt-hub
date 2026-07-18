import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sprintChunks } from "@/lib/db/schema";
import { errChain, firstLine } from "@/app/workshop/db-error";

export const dynamic = "force-dynamic";

interface DeckSummary {
  chunk: number;
  total: number;
  withAudio: number;
  validated: number;
  listenCount: number;
  lastListenedAt: Date | null;
  accuracy: number | null; // 0..1, over the last 100 recall answers for this chunk; null if none yet
}

type ChunkStatsRow = Record<string, unknown> & {
  chunk: number;
  total: string | number;
  with_audio: string | number;
  validated: string | number;
};

type AccuracyRow = Record<string, unknown> & {
  chunk: number;
  n: string | number;
  correct: string | number;
};

type DbState = { status: "ok"; decks: DeckSummary[] } | { status: "missing_url" } | { status: "missing_table" } | { status: "error"; detail: string };

async function loadDecks(): Promise<DbState> {
  try {
    const db = getDb();
    const [statsRes, chunkRows, accuracyRes] = await Promise.all([
      db.execute<ChunkStatsRow>(sql`
        SELECT chunk,
               count(*) AS total,
               count(*) FILTER (WHERE audio_path IS NOT NULL) AS with_audio,
               count(*) FILTER (WHERE validated) AS validated
        FROM sprint_sentences
        GROUP BY chunk
        ORDER BY chunk
      `),
      db.select().from(sprintChunks),
      // Plain accuracy over each chunk's last 100 recall answers — no decay, kept simple.
      db.execute<AccuracyRow>(sql`
        WITH ranked AS (
          SELECT (meta ->> 'chunk')::int AS chunk,
                 correct,
                 row_number() OVER (PARTITION BY (meta ->> 'chunk')::int ORDER BY occurred_at DESC) AS rn
          FROM observations
          WHERE source = 'sprint' AND kind = 'answer' AND meta ->> 'chunk' IS NOT NULL
        )
        SELECT chunk, count(*) AS n, count(*) FILTER (WHERE correct) AS correct
        FROM ranked
        WHERE rn <= 100
        GROUP BY chunk
      `),
    ]);

    const chunkMap = new Map(chunkRows.map((r) => [r.chunk, r]));
    const accuracyMap = new Map(
      accuracyRes.rows.map((r) => [Number(r.chunk), Number(r.n) > 0 ? Number(r.correct) / Number(r.n) : null]),
    );

    const decks: DeckSummary[] = statsRes.rows.map((r) => {
      const chunkState = chunkMap.get(r.chunk);
      return {
        chunk: r.chunk,
        total: Number(r.total),
        withAudio: Number(r.with_audio),
        validated: Number(r.validated),
        listenCount: chunkState?.listenCount ?? 0,
        lastListenedAt: chunkState?.lastListenedAt ?? null,
        accuracy: accuracyMap.get(r.chunk) ?? null,
      };
    });
    return { status: "ok", decks };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

export default async function SprintPage() {
  const db = await loadDecks();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-bold tracking-tight">Sprint</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Brute-force vocab drilling in decks of 100: listen on repeat, read along, recall aloud,
          then sandwich the deck against real native clips once it feels easy.{" "}
          <span className="text-neutral-400">特訓。</span>
        </p>
      </header>

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
      ) : db.decks.length === 0 ? (
        <Notice muted>
          No sprint sentences yet — run <code>npm run sprint:generate</code>, then{" "}
          <code>npm run sprint:tts</code>.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-3">
          {db.decks.map((deck) => (
            <li key={deck.chunk}>
              <Link
                href={`/sprint/${deck.chunk}`}
                className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-bold">Deck {deck.chunk + 1}</span>
                  <span className="text-xs text-neutral-400">{deck.total} items</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
                  <span>{Math.round((deck.withAudio / deck.total) * 100)}% with audio</span>
                  <span>
                    {deck.listenCount} listen pass{deck.listenCount === 1 ? "" : "es"}
                  </span>
                  <span>
                    {deck.accuracy === null ? "no recall yet" : `${Math.round(deck.accuracy * 100)}% recall`}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
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
