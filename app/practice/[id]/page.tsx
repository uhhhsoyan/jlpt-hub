import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { practiceSessions, practiceQuestions, type PracticeSessionRow, type PracticeQuestionRow } from "@/lib/db/schema";
import type { PracticeSection } from "@/lib/types";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { StatusBadge } from "../status-badge";
import { QuestionCard } from "./question-card";
import { ConfirmButton } from "./confirm-button";

export const dynamic = "force-dynamic";

const SECTION_LABEL: Record<PracticeSection, string> = {
  kanji: "Kanji",
  vocab: "Vocab",
  grammar: "Grammar",
  reading: "Reading",
  listening: "Listening",
  other: "Other",
};

type DbState =
  | { status: "ok"; session: PracticeSessionRow; questions: PracticeQuestionRow[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string }
  | { status: "not_found" };

async function loadSession(id: string): Promise<DbState> {
  try {
    const db = getDb();
    const [session] = await db.select().from(practiceSessions).where(eq(practiceSessions.id, id));
    if (!session) return { status: "not_found" };

    const questions = await db
      .select()
      .from(practiceQuestions)
      .where(eq(practiceQuestions.sessionId, id))
      .orderBy(asc(practiceQuestions.number));

    return { status: "ok", session, questions };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

interface SectionScore {
  graded: number;
  correct: number;
}

function scoreSummary(questions: PracticeQuestionRow[]) {
  let graded = 0;
  let correct = 0;
  const bySection = new Map<PracticeSection, SectionScore>();
  for (const q of questions) {
    if (q.isCorrect === null) continue;
    graded += 1;
    if (q.isCorrect) correct += 1;
    const entry = bySection.get(q.section) ?? { graded: 0, correct: 0 };
    entry.graded += 1;
    if (q.isCorrect) entry.correct += 1;
    bySection.set(q.section, entry);
  }
  return { graded, correct, bySection };
}

export default async function PracticeSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = await loadSession(id);

  if (db.status === "not_found") notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-10 font-sans">
      <Link
        href="/practice"
        className="w-fit text-sm text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300"
      >
        ← Practice
      </Link>

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code> and run{" "}
          <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the practice tables don&apos;t exist yet. Run{" "}
          <code>npm run db:push</code>.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : (
        <SessionDetail session={db.session} questions={db.questions} />
      )}
    </div>
  );
}

function SessionDetail({
  session,
  questions,
}: {
  session: PracticeSessionRow;
  questions: PracticeQuestionRow[];
}) {
  const isConfirmed = session.status === "confirmed";
  const { graded, correct, bySection } = scoreSummary(questions);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight">{session.label}</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {session.sourceName && <>{session.sourceName} · </>}
              {session.takenAt.toISOString().slice(0, 10)}
            </p>
          </div>
          <StatusBadge status={session.status} />
        </div>

        {session.imagePaths.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {session.imagePaths.map((src, i) => (
              <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- local static file under public/, not worth an Image loader for a small thumbnail */}
                <img
                  src={src}
                  alt={`Page ${i + 1}`}
                  className="h-16 w-16 rounded-lg border border-neutral-200 object-cover dark:border-neutral-800"
                />
              </a>
            ))}
          </div>
        )}
      </header>

      {isConfirmed ? (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Score</span>
            <span className="text-lg font-bold">
              {graded > 0 ? `${correct}/${graded} (${Math.round((correct / graded) * 100)}%)` : "—"}
            </span>
          </div>
          {bySection.size > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
              {[...bySection.entries()].map(([section, s]) => (
                <span key={section}>
                  {SECTION_LABEL[section]} {s.correct}/{s.graded}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <p>Check the extraction before it counts — fix any misread choices, then confirm.</p>
          <ConfirmButton sessionId={session.id} />
        </div>
      )}

      <div className="flex flex-col gap-3">
        {questions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
            No questions were extracted from these photos.
          </p>
        ) : (
          questions.map((q) => <QuestionCard key={q.id} question={q} editable={!isConfirmed} />)
        )}
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {children}
    </p>
  );
}
