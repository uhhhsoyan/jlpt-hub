import { STUDY_ACTIVITY_LABEL } from "@/lib/types";
import type { FeedInsightEntry, FeedStudyEntry, FeedWordsEntry } from "@/lib/study-feed";
import { formatMinutes } from "@/app/sources/source-card";
import { SourceThumb } from "./source-thumb";
import { TagChips, Words } from "./session-entry";

/** Insights longer than this start clamped, with the full text one tap away. */
const INSIGHT_CLAMP_CHARS = 260;

export function InsightEntry({ entry }: { entry: FeedInsightEntry }) {
  const long = entry.text.length > INSIGHT_CLAMP_CHARS;
  const body = "whitespace-pre-line text-[15px] leading-relaxed text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-100";
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-3 dark:border-indigo-900/60 dark:bg-indigo-950/30">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">Insight</span>
        {entry.time && <span className="text-neutral-400">{entry.time}</span>}
      </div>
      {long ? (
        <details className="group">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <p className={`${body} line-clamp-4 group-open:line-clamp-none`}>{entry.text}</p>
            <span className="mt-1 inline-block text-xs font-semibold text-indigo-600 group-open:hidden dark:text-indigo-300">
              Read all
            </span>
          </summary>
        </details>
      ) : (
        <p className={body}>{entry.text}</p>
      )}
      {entry.items.length > 0 && <TagChips tags={entry.items} />}
      {entry.tags.length > 0 && (
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-400">
          {entry.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </p>
      )}
    </article>
  );
}

export function StudyEntry({ entry }: { entry: FeedStudyEntry }) {
  return (
    <article className="flex items-start gap-2.5 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
      <SourceThumb source={entry.source} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-snug">
          <span className="font-semibold">{STUDY_ACTIVITY_LABEL[entry.activity]}</span>
          {entry.minutes != null && entry.minutes > 0 && <span className="text-neutral-500"> · {formatMinutes(entry.minutes)}</span>}
          {entry.source && <span className="text-neutral-500"> · {entry.source.name}</span>}
        </p>
        {entry.note && <p className="mt-0.5 text-sm leading-relaxed text-neutral-600 [overflow-wrap:anywhere] dark:text-neutral-300">{entry.note}</p>}
        <p className="mt-0.5 text-[11px] text-neutral-400">Study log{entry.time && ` · ${entry.time}`}</p>
      </div>
    </article>
  );
}

export function LooseWordsEntry({ entry }: { entry: FeedWordsEntry }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white/70 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/60">
      <Words words={entry.words} label={entry.label} />
    </div>
  );
}
