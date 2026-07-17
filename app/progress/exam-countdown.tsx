// JLPT N4, US administration.
const EXAM_DATE = { year: 2026, month: 11, day: 6 }; // Sunday, Dec 6 2026 (month is 0-indexed)
const REGISTRATION_CLOSES = { year: 2026, month: 8, day: 16 }; // Sep 16 2026

function daysBetween(from: Date, to: { year: number; month: number; day: number }): number {
  // Compare whole calendar dates (UTC) so server timezone can't shift the day count.
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.year, to.month, to.day);
  return Math.round((b - a) / 86_400_000);
}

/** Exam countdown + registration-window reminder, computed server-side from the current date. */
export function ExamCountdown() {
  const now = new Date();
  const daysRemaining = daysBetween(now, EXAM_DATE);
  const pastRegistration = daysBetween(now, REGISTRATION_CLOSES) < 0;

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
        JLPT N4 —{" "}
        {daysRemaining >= 0
          ? `${daysRemaining.toLocaleString()} day${daysRemaining === 1 ? "" : "s"} to go`
          : "exam day has passed"}
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {pastRegistration
          ? "Exam day: Sunday, December 6, 2026."
          : "Registration opens ~mid-August 2026 and closes Sep 16 — check aatj.org/jlpt-us in late July."}
      </p>
    </div>
  );
}
