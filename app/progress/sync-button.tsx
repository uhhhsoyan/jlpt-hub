"use client";

import { useState, useTransition } from "react";
import { runWanikaniSync } from "./actions";

export function WanikaniSyncButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  function onSync() {
    setMessage(null);
    setIsError(false);
    startTransition(async () => {
      const result = await runWanikaniSync();
      if (result.ok) {
        const { itemsMapped, subjectsFetched } = result.summary;
        setIsError(false);
        setMessage(
          `${itemsMapped.toLocaleString()} items updated from ${subjectsFetched.toLocaleString()} subjects.`,
        );
      } else {
        setIsError(true);
        setMessage(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onSync}
        disabled={pending}
        className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {pending ? "Syncing…" : "Sync WaniKani"}
      </button>
      {message && (
        <span
          className={
            isError
              ? "text-sm text-red-600 dark:text-red-400"
              : "text-sm text-neutral-500 dark:text-neutral-400"
          }
        >
          {message}
        </span>
      )}
    </div>
  );
}
