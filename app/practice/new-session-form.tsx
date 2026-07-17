"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSession } from "./actions";

const SOURCE_SUGGESTIONS = ["Shin Nihongo 500 Mon (N4–N5)", "Official JLPT practice workbook"];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function NewSessionForm() {
  const router = useRouter();
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    previews.forEach((url) => URL.revokeObjectURL(url));
    const files = Array.from(e.target.files ?? []);
    setPreviews(files.map((f) => URL.createObjectURL(f)));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createSession(formData);
      if (result.ok) {
        previews.forEach((url) => URL.revokeObjectURL(url));
        router.push(`/practice/${result.sessionId}`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">New session</h2>

      <div className="flex flex-col gap-2">
        <label htmlFor="label" className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
          Label
        </label>
        <input
          id="label"
          name="label"
          required
          placeholder="e.g. 500問 Week 2 Day 3"
          className="w-full rounded-xl border border-neutral-300 bg-white p-2.5 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-indigo-900"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="sourceName" className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            Source <span className="text-neutral-400">(optional)</span>
          </label>
          <input
            id="sourceName"
            name="sourceName"
            list="practice-source-suggestions"
            placeholder="Shin Nihongo 500 Mon (N4–N5)"
            className="w-full rounded-xl border border-neutral-300 bg-white p-2.5 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-indigo-900"
          />
          <datalist id="practice-source-suggestions">
            {SOURCE_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="takenAt" className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            Date taken
          </label>
          <input
            id="takenAt"
            name="takenAt"
            type="date"
            defaultValue={todayIso()}
            className="w-full rounded-xl border border-neutral-300 bg-white p-2.5 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-indigo-900"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="images" className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
          Photos of the completed page(s)
        </label>
        <input
          id="images"
          name="images"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          onChange={onFilesChange}
          className="w-full rounded-xl border border-dashed border-neutral-300 bg-white p-2.5 text-sm text-neutral-500 outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:file:bg-neutral-800 dark:file:text-neutral-200"
        />
        {previews.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {previews.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- local blob preview, not an optimizable remote asset
              <img
                key={src}
                src={src}
                alt={`Page ${i + 1} preview`}
                className="h-20 w-20 rounded-lg border border-neutral-200 object-cover dark:border-neutral-800"
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
        >
          {pending ? "Reading photos…" : "Create session"}
        </button>
      </div>
    </form>
  );
}
