export interface MasteryDotProps {
  /** Reserved for a future mastery/SRS score; unused today, always renders neutral. */
  score?: number;
}

/** Placeholder slot for future mastery tracking — just a quiet dot for now. */
export function MasteryDot({ score }: MasteryDotProps) {
  const title = score === undefined ? "mastery tracking coming soon" : `mastery tracking coming soon (score: ${score})`;
  return (
    <span
      title={title}
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-700"
    />
  );
}
