import Link from "next/link";
import type { StudySourceRow } from "@/lib/db/schema";
import type { SourceStats } from "@/lib/study-sources-db";
import { STUDY_SOURCE_KIND_LABEL } from "@/lib/types";
import { resolveSourceImage } from "./image";
import { SourceArt } from "./source-art";

export function formatDay(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "3 lessons · 1 practice · 45 min · last 2026-11-04", dropping the zero parts; "unused" when nothing is logged. */
export function statsLine(stats: SourceStats): string {
  const parts: string[] = [];
  if (stats.lessonSessions > 0) parts.push(`${stats.lessonSessions} lesson${stats.lessonSessions === 1 ? "" : "s"}`);
  if (stats.practiceSessions > 0) parts.push(`${stats.practiceSessions} practice`);
  if (stats.minutes > 0) parts.push(formatMinutes(stats.minutes));
  else if (stats.logEntries > 0) parts.push(`${stats.logEntries} log${stats.logEntries === 1 ? "" : "s"}`);
  if (parts.length === 0) return "unused";
  const last = formatDay(stats.lastUsedAt);
  return last ? `${parts.join(" · ")} · last ${last}` : parts.join(" · ");
}

export function LevelBadge({ level }: { level: string | null }) {
  if (!level) return null;
  return (
    <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
      {level}
    </span>
  );
}

export function SourceCard({ source, stats }: { source: StudySourceRow; stats: SourceStats }) {
  const imageSrc = resolveSourceImage(source.slug, source.imageUrl);
  return (
    <Link
      href={`/sources/${source.slug}`}
      className="group flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm transition hover:border-neutral-300 hover:shadow dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
    >
      <SourceArt name={source.name} nameJa={source.nameJa} level={source.level} color={source.color} imageSrc={imageSrc} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-sm font-semibold leading-snug group-hover:underline">{source.name}</p>
          <LevelBadge level={source.level} />
        </div>
        {source.nameJa && <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{source.nameJa}</p>}
        <p className="text-[11px] uppercase tracking-wide text-neutral-400">{STUDY_SOURCE_KIND_LABEL[source.kind]}</p>
        {source.description && (
          <p className="line-clamp-2 text-xs leading-snug text-neutral-500 dark:text-neutral-400">{source.description}</p>
        )}
        <p className="text-[11px] text-neutral-400">{statsLine(stats)}</p>
      </div>
    </Link>
  );
}
