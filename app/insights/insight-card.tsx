import Link from "next/link";
import { NO_FILTER, shortDate } from "@/lib/study-feed";
import { hasTag, insightsHref, withTag, type InsightCard as Card, type InsightsQuery } from "@/lib/insights-view";
import type { InsightMatch } from "@/lib/insight-match";
import { InsightText } from "@/app/_journal/entries";
import { TagChips } from "@/app/_journal/session-entry";
import { journalHref } from "@/app/_journal/href";

/** Only insights past this start clamped here: this page is for reading. */
const CARD_CLAMP_CHARS = 700;

const MATCH_LABEL: Record<InsightMatch, { label: string; title: string }> = {
  item: { label: "item match", title: "About a library item (or item) the search names" },
  tag: { label: "tag match", title: "Carries the search as a tag" },
  text: { label: "text match", title: "Only the text mentions it" },
};

const SOURCE_LABEL: Record<string, string> = { hub: "logged in the Hub", "claude-code": "from Claude Code", import: "imported" };

/** The journal day the insight was logged on, scrolled to that day. */
export function journalDayHref(day: string): string {
  return `${journalHref({ to: day, filter: NO_FILTER })}#day-${day}`;
}

export function InsightCard({ card, query }: { card: Card; query: InsightsQuery }) {
  const items = card.items.map((i) => ({ ...i, linked: i.itemId !== null }));
  return (
    <article className="flex flex-col gap-2.5 rounded-xl border border-neutral-200 bg-white px-4 py-3.5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        <Link href={journalDayHref(card.day)} title="Open this day in the Journal" className="font-semibold hover:text-indigo-600 hover:underline dark:hover:text-indigo-300">
          {shortDate(card.day)}
        </Link>
        {card.source !== "claude-ai" && <span>· {SOURCE_LABEL[card.source] ?? card.source}</span>}
        {card.matched && (
          <span
            title={MATCH_LABEL[card.matched].title}
            className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              card.matched === "text"
                ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                : "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
            }`}
          >
            {MATCH_LABEL[card.matched].label}
          </span>
        )}
      </div>

      <InsightText text={card.text} clampChars={CARD_CLAMP_CHARS} lines={8} size="text-base" />

      {items.length > 0 && <TagChips tags={items} href={(i) => insightsHref({ ...query, item: i.param })} />}
      {card.tags.length > 0 && (
        <p className="flex flex-wrap gap-x-2.5 gap-y-1 text-xs">
          {card.tags.map((t) =>
            hasTag(query, t) ? (
              <span key={t} className="font-semibold text-indigo-600 dark:text-indigo-300">
                #{t}
              </span>
            ) : (
              <Link
                key={t}
                href={insightsHref(withTag(query, t))}
                title={`Also filter by #${t}`}
                className="text-neutral-400 hover:text-neutral-700 hover:underline dark:text-neutral-500 dark:hover:text-neutral-200"
              >
                #{t}
              </Link>
            ),
          )}
        </p>
      )}
    </article>
  );
}
