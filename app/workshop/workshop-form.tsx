"use client";

import { useState, useTransition } from "react";
import { generate, save } from "./actions";
import type { GeneratedSentence, SentenceVersion, StudyLevel } from "@/lib/types";
import { LevelBadge } from "./level-badge";
import { Furigana } from "@/app/furigana";

export function Workshop() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<GeneratedSentence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedLevels, setSavedLevels] = useState<StudyLevel[]>([]);
  const [savingLevel, setSavingLevel] = useState<StudyLevel | null>(null);
  const [genPending, startGen] = useTransition();
  const [, startSave] = useTransition();

  function onGenerate() {
    setError(null);
    setSavedLevels([]);
    startGen(async () => {
      const r = await generate(input);
      if (r.ok) setResult(r.data);
      else {
        setResult(null);
        setError(r.error);
      }
    });
  }

  function onSave(level: StudyLevel) {
    if (!result || savingLevel) return;
    setError(null);
    setSavingLevel(level);
    startSave(async () => {
      const r = await save(input, result, level);
      if (r.ok) setSavedLevels((prev) => [...prev, level]);
      else setError(r.error);
      setSavingLevel(null);
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="en" className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
          Say it in English — something you&apos;d actually think or say
        </label>
        <textarea
          id="en"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onGenerate();
          }}
          rows={3}
          placeholder="e.g. I was going to go running this morning, but it was raining so I stayed home."
          className="w-full resize-none rounded-xl border border-neutral-300 bg-white p-3 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-indigo-900"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={onGenerate}
            disabled={genPending || !input.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            {genPending ? "Generating…" : "Generate"}
          </button>
          <span className="text-xs text-neutral-400">⌘/Ctrl + Enter</span>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {result && (
        <Result
          data={result}
          onSave={onSave}
          savingLevel={savingLevel}
          savedLevels={savedLevels}
        />
      )}
    </section>
  );
}

function Result({
  data,
  onSave,
  savingLevel,
  savedLevels,
}: {
  data: GeneratedSentence;
  onSave: (level: StudyLevel) => void;
  savingLevel: StudyLevel | null;
  savedLevels: StudyLevel[];
}) {
  return (
    <div className="flex flex-col gap-4">
      {data.versions.map((version, i) => (
        <VersionCard
          key={version.level}
          version={version}
          isPrimary={i === 0}
          withinLevel={data.withinLevel}
          onSave={() => onSave(version.level)}
          saving={savingLevel === version.level}
          saved={savedLevels.includes(version.level)}
        />
      ))}

      {(data.faithful.differs || data.notes) && (
        <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          {data.faithful.differs && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Faithful version
                </span>
                <LevelBadge level={data.faithful.levelTag} />
                <span className="text-[11px] text-neutral-400">approx.</span>
              </div>
              <Furigana
                japanese={data.faithful.japanese}
                reading={data.faithful.reading}
                className="text-xl leading-[1.9] tracking-tight"
              />
            </div>
          )}
          {data.notes && (
            <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
              {data.notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function VersionCard({
  version,
  isPrimary,
  withinLevel,
  onSave,
  saving,
  saved,
}: {
  version: SentenceVersion;
  isPrimary: boolean;
  withinLevel: boolean;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
            {version.level} version
          </span>
          {isPrimary && !withinLevel && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              simplified — some nuance dropped
            </span>
          )}
        </div>
        <Furigana
          japanese={version.japanese}
          reading={version.reading}
          className="text-2xl leading-[1.9] tracking-tight"
        />
        <p className="mt-1 text-[15px] text-neutral-700 dark:text-neutral-300">
          &ldquo;{version.gloss}&rdquo;
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Breakdown title="Grammar">
          {version.grammar.length === 0 ? (
            <Empty />
          ) : (
            version.grammar.map((g, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <LevelBadge level={g.level} />
                <span>
                  <span className="font-medium">{g.pattern}</span>
                  <span className="text-neutral-500 dark:text-neutral-400"> — {g.note}</span>
                </span>
              </li>
            ))
          )}
        </Breakdown>
        <Breakdown title="Vocabulary">
          {version.vocab.length === 0 ? (
            <Empty />
          ) : (
            version.vocab.map((v, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <LevelBadge level={v.level} />
                <span>
                  <span className="font-medium">{v.word}</span>
                  {v.reading && v.reading !== v.word && (
                    <span className="text-neutral-400"> ({v.reading})</span>
                  )}
                  <span className="text-neutral-500 dark:text-neutral-400"> — {v.meaning}</span>
                </span>
              </li>
            ))
          )}
        </Breakdown>
      </div>

      <div className="flex items-center gap-3 border-t border-neutral-100 pt-4 dark:border-neutral-800">
        <button
          onClick={onSave}
          disabled={saving || saved}
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold transition hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {saved ? "Saved ✓" : saving ? "Saving…" : `Save ${version.level} to my sentences`}
        </button>
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Added below.</span>}
      </div>
    </div>
  );
}

function Breakdown({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{title}</h3>
      <ul className="flex flex-col gap-1.5">{children}</ul>
    </div>
  );
}

function Empty() {
  return <li className="text-sm text-neutral-400">None flagged.</li>;
}
