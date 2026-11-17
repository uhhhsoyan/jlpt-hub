import Link from "next/link";
import { rootCauseLabel, type SessionMode } from "@/lib/types";
import { shortDate, type FeedMiss, type FeedNoted, type FeedScore, type FeedSessionEntry, type FeedTag, type FeedWord } from "@/lib/study-feed";
import type { Slip } from "@/lib/attempt-meta";
import { SourceThumb } from "./source-thumb";

/** Slip notes beyond this many start folded, so the misses stay the first thing read. */
const NOTED_OPEN_MAX = 3;

/**
 * Closed book and open book mean different things (accuracy vs exposure), so they never
 * look alike: closed book is a solid card with an accent rule and a filled badge; open book
 * is a dashed card with an outlined badge and a muted score.
 */
export function ModeBadge({ mode }: { mode: SessionMode }) {
  return mode === "practice" ? (
    <span
      title="Closed book: counts toward accuracy"
      className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white"
    >
      Closed book
    </span>
  ) : (
    <span
      title="Open book: exposure only, never counted in accuracy"
      className="shrink-0 rounded-full border border-dashed border-neutral-400 px-2 py-0.5 text-[11px] font-semibold text-neutral-600 dark:border-neutral-500 dark:text-neutral-300"
    >
      Open book
    </span>
  );
}

function cardClass(mode: SessionMode): string {
  return mode === "practice"
    ? "border border-neutral-200 border-l-4 border-l-indigo-500 bg-white dark:border-neutral-800 dark:border-l-indigo-400 dark:bg-neutral-900"
    : "border border-dashed border-neutral-300 bg-white/70 dark:border-neutral-700 dark:bg-neutral-900/60";
}

function Score({ score, mode }: { score: FeedScore; mode: SessionMode }) {
  if (score.graded === 0) {
    return (
      <span className="shrink-0 text-xs text-neutral-400">
        {score.notAttempted > 0 ? `${score.notAttempted} not attempted` : "no graded answers"}
      </span>
    );
  }
  const pct = Math.round((score.correct / score.graded) * 100);
  return (
    <span className="flex shrink-0 flex-col items-end leading-tight">
      <span
        className={`tabular-nums ${mode === "practice" ? "text-base font-bold text-neutral-900 dark:text-neutral-50" : "text-sm font-semibold text-neutral-500 dark:text-neutral-400"}`}
      >
        {score.correct}/{score.graded}
      </span>
      <span className="text-[11px] text-neutral-400">
        {mode === "practice" ? `${pct}%` : "exposure"}
        {score.notAttempted > 0 && ` · ${score.notAttempted} skipped`}
      </span>
    </span>
  );
}

function sourceLine(entry: FeedSessionEntry): string {
  return [entry.source?.name, entry.sourceName].filter(Boolean).join(" · ");
}

function Flags({ entry }: { entry: FeedSessionEntry }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
      <ModeBadge mode={entry.mode} />
      {entry.timed === true && <span>timed</span>}
      {entry.status === "review" && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          needs review
        </span>
      )}
      {entry.time && <span>{entry.time}</span>}
      {entry.alsoDoneOn.length > 0 && <span>also done {entry.alsoDoneOn.map(shortDate).join(", ")}</span>}
    </div>
  );
}

export function SessionEntry({ entry }: { entry: FeedSessionEntry }) {
  const href = `/practice/${entry.id}`;
  const line = sourceLine(entry);

  if (entry.compact) {
    return (
      <article className={`rounded-xl ${cardClass(entry.mode)}`}>
        <Link href={href} className="flex min-h-12 items-center gap-2.5 px-3 py-2">
          <SourceThumb source={entry.source} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium leading-snug">{entry.label}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              {entry.mode === "practice" ? "Closed book" : "Open book"}
              {entry.score.graded > 0 && entry.score.correct === entry.score.graded && " · all right"}
              {entry.status === "review" && " · needs review"}
            </span>
          </span>
          <Score score={entry.score} mode={entry.mode} />
        </Link>
        {entry.words.length > 0 && (
          <div className="border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
            <Words words={entry.words} />
          </div>
        )}
      </article>
    );
  }

  return (
    <article className={`overflow-hidden rounded-xl ${cardClass(entry.mode)}`}>
      <Link href={href} className="group flex items-start gap-3 px-3 pt-3 pb-2.5">
        <SourceThumb source={entry.source} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-[15px] font-semibold leading-snug group-hover:underline">{entry.label}</p>
            <Score score={entry.score} mode={entry.mode} />
          </div>
          {line && <p className="mt-0.5 text-xs leading-snug text-neutral-500 dark:text-neutral-400">{line}</p>}
          <Flags entry={entry} />
        </div>
      </Link>

      <div className="flex flex-col gap-3 border-t border-neutral-100 px-3 py-3 dark:border-neutral-800">
        {entry.misses.length > 0 && (
          <ul className="flex flex-col gap-3">
            {entry.misses.map((m, i) => (
              <MissRow key={`${m.label}-${i}`} miss={m} />
            ))}
          </ul>
        )}
        {entry.noted.length > 0 && <NotedList noted={entry.noted} />}
        {entry.words.length > 0 && <Words words={entry.words} />}
      </div>
    </article>
  );
}

function MissRow({ miss }: { miss: FeedMiss }) {
  return (
    <li className="flex gap-2">
      <span className="w-11 shrink-0 pt-0.5 text-sm font-bold tabular-nums text-red-600 dark:text-red-400">
        <span aria-label="missed">✗</span> #{miss.label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-[15px] leading-relaxed text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-100">
          {miss.rootCause && (
            <span className="mr-1.5 inline-block rounded-full bg-rose-100 px-2 py-0.5 align-[1px] text-[11px] font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-300">
              {rootCauseLabel(miss.rootCause)}
            </span>
          )}
          {miss.note ?? <span className="text-neutral-400">No note logged.</span>}
        </p>
        {miss.stem && (
          <p lang="ja" className="rounded-lg bg-neutral-50 px-2.5 py-1.5 text-[15px] leading-relaxed text-neutral-600 [overflow-wrap:anywhere] dark:bg-neutral-800/60 dark:text-neutral-300">
            {miss.stem}
          </p>
        )}
        {miss.tags.length > 0 && <TagChips tags={miss.tags} />}
        {miss.slips.length > 0 && <SlipList slips={miss.slips} />}
      </div>
    </li>
  );
}

export function TagChips({ tags }: { tags: FeedTag[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span
          key={t.text}
          lang="ja"
          title={t.linked ? "Linked to the library" : "Not matched to a library item"}
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            t.linked
              ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"
              : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          }`}
        >
          {t.text}
        </span>
      ))}
    </div>
  );
}

function SlipList({ slips }: { slips: Slip[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-sm text-neutral-500 dark:text-neutral-400">
      {slips.map((s, i) => (
        <li key={i}>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{s.kind}</span> {s.text}
        </li>
      ))}
    </ul>
  );
}

function NotedList({ noted }: { noted: FeedNoted[] }) {
  return (
    <details open={noted.length <= NOTED_OPEN_MAX} className="group">
      <summary className="cursor-pointer select-none py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Slips &amp; notes · {noted.length}
      </summary>
      <ul className="mt-1 flex flex-col gap-1.5">
        {noted.map((n, i) => (
          <li key={`${n.label}-${i}`} className="flex gap-2 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            <span className="w-11 shrink-0 tabular-nums text-neutral-400">
              {n.kind === "skipped" ? "–" : "✓"} #{n.label}
            </span>
            <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {n.kind === "skipped" && <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide">not attempted</span>}
              {n.note}
              {n.slips.length > 0 && <SlipList slips={n.slips} />}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Words({ words, label }: { words: FeedWord[]; label?: string | null }) {
  return (
    <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
      <Link
        href="/queue"
        className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
      >
        Queued
      </Link>
      {label && <span className="mr-1 text-neutral-500 dark:text-neutral-400">{label}:</span>}
      {words.map((w, i) => (
        <span key={`${w.id}-${i}`} lang="ja">
          {i > 0 && <span className="text-neutral-300 dark:text-neutral-600"> · </span>}
          <span className="text-[15px] font-medium text-neutral-800 dark:text-neutral-100">{w.text}</span>
          {w.asMet ? (
            <span className="text-xs text-neutral-400"> ({w.asMet})</span>
          ) : w.reading && w.reading !== w.text ? (
            <span className="text-xs text-neutral-400"> {w.reading}</span>
          ) : null}
        </span>
      ))}
    </p>
  );
}
