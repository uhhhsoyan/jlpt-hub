import type { MasteryStatus } from "@/lib/types";

export interface MasteryDotProps {
  status?: MasteryStatus;
  /** 0..1, shown in the tooltip when known. */
  score?: number;
  observationCount?: number;
}

const DOT_CLASS: Record<MasteryStatus, string> = {
  unseen: "bg-neutral-300 dark:bg-neutral-700",
  learning: "bg-amber-400 dark:bg-amber-500",
  solid: "bg-sky-500 dark:bg-sky-400",
  mastered: "bg-emerald-500 dark:bg-emerald-400",
};

/** Per-item mastery indicator, driven by the observations ledger (lib/mastery.ts). */
export function MasteryDot({ status = "unseen", score, observationCount }: MasteryDotProps) {
  const title =
    status === "unseen"
      ? "no study evidence yet"
      : `${status} — score ${(score ?? 0).toFixed(2)} from ${observationCount ?? 0} observation${observationCount === 1 ? "" : "s"}`;
  return (
    <span
      title={title}
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[status]}`}
    />
  );
}
