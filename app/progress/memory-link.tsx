import { memoryUiUrl } from "@/lib/hindsight";

/**
 * Link to the Hindsight bank's graphs (constellation of memories, entity co-occurrence).
 * Server-rendered from HINDSIGHT_UI_URL; renders nothing when the add-on is not wired up.
 * The target sits behind Cloudflare Access plus Hindsight's own login, so the link is
 * useless to anyone but the owner (docs/plans/07-hindsight.md, Phase B).
 */
export function MemoryLink() {
  const href = memoryUiUrl();
  if (!href) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Memory graph</h2>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm transition hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
      >
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">Open the Hindsight bank</span>
          <span className="text-neutral-500">
            Insights and sessions from this ledger as a memory graph: constellation view, entities, timeline.
            Signs in through Cloudflare Access, then the bank&apos;s own access key.
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-neutral-400">
          ↗
        </span>
      </a>
    </section>
  );
}
