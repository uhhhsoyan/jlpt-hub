import { LevelBadge } from "@/app/workshop/level-badge";
import type { WeakItem } from "@/lib/weakness";

const KIND_LABEL: Record<WeakItem["kind"], string> = {
  vocab: "Vocab",
  kanji: "Kanji",
  grammar: "Grammar",
};

export function WeakPointsPanel({ items }: { items: WeakItem[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Weak points</h2>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
          Confirm a few sessions and weak points will show up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.itemId}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <LevelBadge level={item.level} />
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                {KIND_LABEL[item.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-[15px]">{item.headword}</span>
                {item.reading && item.reading !== item.headword && (
                  <span className="ml-2 text-sm text-neutral-400">{item.reading}</span>
                )}
              </div>
              <span className="shrink-0 text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                {Math.round(item.accuracy * 100)}%
              </span>
              <span className="shrink-0 text-xs text-neutral-400">
                {item.answerCount} answer{item.answerCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
