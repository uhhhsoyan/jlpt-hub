"use client";

import { useState, useTransition } from "react";
import { updateQuestion } from "../actions";
import type { PracticeQuestionRow } from "@/lib/db/schema";
import type { PracticeSection } from "@/lib/types";

const SECTION_LABEL: Record<PracticeSection, string> = {
  kanji: "Kanji",
  vocab: "Vocab",
  grammar: "Grammar",
  reading: "Reading",
  listening: "Listening",
  other: "Other",
};

export function QuestionCard({
  question,
  editable,
}: {
  question: PracticeQuestionRow;
  editable: boolean;
}) {
  const [userChoice, setUserChoice] = useState(question.userChoice);
  const [correctChoice, setCorrectChoice] = useState(question.correctChoice);
  const [isCorrect, setIsCorrect] = useState(question.isCorrect);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function apply(next: { userChoice?: number | null; correctChoice?: number | null }) {
    const nextUser = next.userChoice !== undefined ? next.userChoice : userChoice;
    const nextCorrect = next.correctChoice !== undefined ? next.correctChoice : correctChoice;
    setUserChoice(nextUser);
    setCorrectChoice(nextCorrect);
    setIsCorrect(nextUser != null && nextCorrect != null ? nextUser === nextCorrect : null);
    setError(null);
    startTransition(async () => {
      const result = await updateQuestion(question.id, next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-400">#{question.number}</span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {SECTION_LABEL[question.section]}
          </span>
        </div>
        <ResultMark isCorrect={isCorrect} />
      </div>

      <p className="text-lg leading-snug">{question.stem}</p>

      <ul className="flex flex-col gap-1.5">
        {question.choices.map((choice, i) => (
          <li key={i}>
            <ChoiceRow
              index={i}
              text={choice}
              isUser={userChoice === i}
              isCorrectChoice={correctChoice === i}
              editable={editable}
              onPickUser={() => apply({ userChoice: userChoice === i ? null : i })}
              onPickCorrect={() => apply({ correctChoice: correctChoice === i ? null : i })}
            />
          </li>
        ))}
      </ul>

      {question.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {question.tags.map((tag, i) => (
            <span
              key={i}
              title={tag.itemId ? "Linked to the library" : "Not matched to a library item"}
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                tag.itemId
                  ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"
                  : "bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500"
              }`}
            >
              {tag.text}
            </span>
          ))}
        </div>
      )}

      {question.explanation && (
        <details className="text-sm text-neutral-500 dark:text-neutral-400">
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-neutral-400">
            Explanation
          </summary>
          <p className="mt-1">{question.explanation}</p>
        </details>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function ResultMark({ isCorrect }: { isCorrect: boolean | null }) {
  if (isCorrect === null) {
    return <span className="text-sm text-neutral-300 dark:text-neutral-600">—</span>;
  }
  return isCorrect ? (
    <span className="text-base font-semibold text-emerald-600 dark:text-emerald-400">✓</span>
  ) : (
    <span className="text-base font-semibold text-red-600 dark:text-red-400">✗</span>
  );
}

function ChoiceRow({
  index,
  text,
  isUser,
  isCorrectChoice,
  editable,
  onPickUser,
  onPickCorrect,
}: {
  index: number;
  text: string;
  isUser: boolean;
  isCorrectChoice: boolean;
  editable: boolean;
  onPickUser: () => void;
  onPickCorrect: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
        isCorrectChoice
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40"
          : isUser
            ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
            : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <span className="flex-1">
        {index + 1}. {text}
      </span>
      {editable ? (
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={onPickUser}
            aria-pressed={isUser}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
              isUser
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
            }`}
          >
            Marked
          </button>
          <button
            type="button"
            onClick={onPickCorrect}
            aria-pressed={isCorrectChoice}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
              isCorrectChoice
                ? "bg-emerald-600 text-white"
                : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
            }`}
          >
            Correct
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 gap-2 text-[11px] font-medium text-neutral-400">
          {isUser && <span>marked</span>}
          {isCorrectChoice && <span>correct</span>}
        </div>
      )}
    </div>
  );
}
