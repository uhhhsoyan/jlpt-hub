import Link from "next/link";
import { STUDY_ACTIVITY_LABEL } from "@/lib/types";
import { insightsHref } from "@/lib/insights-view";
import type { FeedInsightEntry, FeedStudyEntry, FeedWordsEntry } from "@/lib/study-feed";
import { formatMinutes } from "@/app/sources/source-card";
import { SourceThumb } from "./source-thumb";
import { TagChips, Words } from "./session-entry";

/** Insights longer than this start clamped, with the full text one tap away. */
const INSIGHT_CLAMP_CHARS = 260;

const CLAMP = { 4: "line-clamp-4", 8: "line-clamp-8" } as const;

/**
 * An insight's text; past `clampChars` it starts clamped to `lines` lines inside a native
 * <details>, so the rest is one tap away without any client JS. Shared with /insights.
 */
export function InsightText({ text, clampChars, lines, size }: { text: string; clampChars: number; lines: keyof typeof CLAMP; size: string }) {
  const body = `whitespace-pre-line ${size} leading-relaxed text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-100`;
  return text.length > clampChars ? (
    <details className="group">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <p className={`${body} ${CLAMP[lines]} group-open:line-clamp-none`}>{text}</p>
        <span className="mt-1 inline-block text-xs font-semibold text-indigo-600 group-open:hidden dark:text-indigo-300">Read all</span>
      </summary>
    </details>
  ) : (
    <p className={body}>{text}</p>
  );
}

export function InsightEntry({ entry }: { entry: FeedInsightEntry }) {
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-3 dark:border-indigo-900/60 dark:bg-indigo-950/30">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">Insight</span>
        {entry.time && <span className="text-neutral-400">{entry.time}</span>}
      </div>
      <InsightText text={entry.text} clampChars={INSIGHT_CLAMP_CHARS} lines={4} size="text-[15px]" />
      {entry.items.length > 0 && <TagChips tags={entry.items} href={(t) => insightsHref({ item: t.text })} />}
      {entry.tags.length > 0 && (
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-400">
          {entry.tags.map((t) => (
            <Link key={t} href={insightsHref({ tags: [t] })} className="hover:text-neutral-600 hover:underline dark:hover:text-neutral-200">
              #{t}
            </Link>
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
