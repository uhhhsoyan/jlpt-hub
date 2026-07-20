import type { PracticeSessionStatus } from "@/lib/types";

const STYLES: Record<PracticeSessionStatus, string> = {
  review: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  confirmed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
};

const LABEL: Record<PracticeSessionStatus, string> = {
  review: "Review",
  confirmed: "Confirmed",
};

export function StatusBadge({ status }: { status: PracticeSessionStatus }) {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STYLES[status]}`}>
      {LABEL[status]}
    </span>
  );
}
