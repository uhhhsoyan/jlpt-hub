import { after } from "next/server";
import { count, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { syncWanikaniIfStale } from "@/lib/wanikani";
import { syncBunproIfStale } from "@/lib/bunpro";
import { bpSnapshot, integrationSettings, observations, wkSnapshot } from "@/lib/db/schema";
import { COVERAGE_KINDS as KINDS, getCoverage, type CoverageBucket } from "@/lib/readiness";
import { getAccuracyBySection, getMissesByRootCause, getWeakItems, type WeakItem } from "@/lib/weakness";
import { errChain, firstLine } from "@/app/workshop/db-error";
import type { ItemKind } from "@/lib/types";
import { IntegrationsPanel, type IntegrationState } from "./integrations-panel";
import { ExamCountdown } from "./exam-countdown";
import { CoverageBar, CoverageLegend } from "./coverage";
import { WeakPoints } from "./weak-points";
import { RootCauses, type RootCausesData } from "./root-causes";
import { EvidenceVolume, type EvidenceWeekData } from "./evidence-volume";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<ItemKind, string> = { vocab: "Vocab", kanji: "Kanji", grammar: "Grammar" };

type EvidenceRow = Record<string, unknown> & {
  week_start: string | Date;
  source: string | null;
  n: string | number;
};

/** Last 8 ISO weeks (Postgres date_trunc('week', ...) starts weeks on Monday), zero-filled. */
function buildEvidenceWeeks(rows: EvidenceRow[]): EvidenceWeekData[] {
  const map = new Map<string, EvidenceWeekData>();
  for (const row of rows) {
    const weekStart = new Date(row.week_start).toISOString().slice(0, 10);
    let bucket = map.get(weekStart);
    if (!bucket) {
      bucket = { weekStart, total: 0, bySource: {} };
      map.set(weekStart, bucket);
    }
    if (row.source) {
      const n = Number(row.n);
      bucket.bySource[row.source] = (bucket.bySource[row.source] ?? 0) + n;
      bucket.total += n;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

type DbState =
  | { status: "ok"; coverage: CoverageBucket[]; evidenceWeeks: EvidenceWeekData[] }
  | { status: "missing_url" }
  | { status: "missing_table" }
  | { status: "error"; detail: string };

async function loadDashboard(): Promise<DbState> {
  try {
    const db = getDb();
    const [coverage, weekRes] = await Promise.all([
      getCoverage(),
      db.execute<EvidenceRow>(sql`
        WITH weeks AS (
          SELECT generate_series(
            date_trunc('week', now()) - interval '7 weeks',
            date_trunc('week', now()),
            interval '1 week'
          ) AS week_start
        ),
        obs AS (
          SELECT date_trunc('week', occurred_at) AS week_start, source, count(*) AS n
          FROM observations
          GROUP BY 1, 2
        )
        SELECT w.week_start, o.source, coalesce(o.n, 0) AS n
        FROM weeks w
        LEFT JOIN obs o ON o.week_start = w.week_start
        ORDER BY w.week_start
      `),
    ]);

    return {
      status: "ok",
      coverage,
      evidenceWeeks: buildEvidenceWeeks(weekRes.rows),
    };
  } catch (e) {
    const s = errChain(e);
    if (/DATABASE_URL/i.test(s)) return { status: "missing_url" };
    if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(s)) {
      return { status: "missing_table" };
    }
    return { status: "error", detail: firstLine(s) };
  }
}

/** Weak points is supplementary evidence — soft-fail to empty rather than blocking the page. */
async function loadWeakItems(): Promise<WeakItem[]> {
  try {
    return await getWeakItems({ limit: 15 });
  } catch {
    return [];
  }
}

/** Root-cause facet is supplementary too — soft-fail to empty. */
async function loadRootCauses(): Promise<RootCausesData> {
  try {
    const [recent, month, sections] = await Promise.all([
      getMissesByRootCause(14),
      getMissesByRootCause(30),
      getAccuracyBySection(30),
    ]);
    return { recent, month, sections };
  } catch {
    return { recent: [], month: [], sections: [] };
  }
}

/** State for the Integrations panel; degrades to configured-flags-only if the DB is unreachable. */
async function loadIntegrations(): Promise<IntegrationState[]> {
  const base: IntegrationState[] = [
    {
      source: "wanikani",
      configured: !!process.env.WANIKANI_TOKEN,
      enabled: true,
      syncedAt: null,
      observationCount: 0,
    },
    {
      source: "bunpro",
      configured: !!process.env.BUNPRO_API_KEY,
      enabled: true,
      syncedAt: null,
      observationCount: 0,
    },
  ];
  try {
    const db = getDb();
    const [settings, wkRows, bpRows, counts] = await Promise.all([
      db.select().from(integrationSettings),
      db.select({ syncedAt: wkSnapshot.syncedAt }).from(wkSnapshot),
      db.select({ syncedAt: bpSnapshot.syncedAt }).from(bpSnapshot),
      db
        .select({ source: observations.source, n: count() })
        .from(observations)
        .groupBy(observations.source),
    ]);
    const enabledBySource = new Map(settings.map((s) => [s.source, s.enabled]));
    const countBySource = new Map(counts.map((c) => [c.source, Number(c.n)]));
    return base.map((integration) => ({
      ...integration,
      enabled: enabledBySource.get(integration.source) ?? true,
      syncedAt:
        (integration.source === "wanikani" ? wkRows : bpRows)[0]?.syncedAt.toISOString() ?? null,
      observationCount: countBySource.get(integration.source) ?? 0,
    }));
  } catch {
    return base;
  }
}

export default async function ProgressPage() {
  const [db, weakItems, rootCauses, integrations] = await Promise.all([
    loadDashboard(),
    loadWeakItems(),
    loadRootCauses(),
    loadIntegrations(),
  ]);
  // Refresh integrations in the background when their snapshots are over an hour old.
  after(() => Promise.all([syncWanikaniIfStale(), syncBunproIfStale()]));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Progress</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Readiness across every N5/N4 vocab word, kanji, and grammar point, derived from your
          study evidence. <span className="text-neutral-400">進捗。</span>
        </p>
      </header>

      <ExamCountdown />

      {db.status === "missing_url" ? (
        <Notice>
          Add <code>DATABASE_URL</code> to <code>.env.local</code>, then run{" "}
          <code>npm run db:push</code> and <code>npm run db:seed</code> to load the dashboard.
        </Notice>
      ) : db.status === "missing_table" ? (
        <Notice>
          Database connected, but the knowledge-graph tables don&apos;t exist yet. Run{" "}
          <code>npm run db:push</code>, then <code>npm run db:seed</code>.
        </Notice>
      ) : db.status === "error" ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {db.detail}
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Coverage
              </h2>
            </div>
            <CoverageLegend />
            {KINDS.map((kind) => {
              const kindBuckets = db.coverage.filter((b) => b.kind === kind);
              const kindTotal = kindBuckets.reduce((sum, b) => sum + b.total, 0);
              return (
                <div key={kind} className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    {KIND_LABEL[kind]}
                  </h3>
                  {kindTotal === 0 ? (
                    <p className="text-xs text-neutral-400">
                      {kind === "grammar" ? (
                        <>
                          Grammar list not seeded yet — run <code>npm run db:seed</code> once{" "}
                          <code>data/seed/grammar.json</code> exists.
                        </>
                      ) : (
                        <>No {KIND_LABEL[kind].toLowerCase()} items seeded yet.</>
                      )}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {kindBuckets
                        .filter((b) => b.total > 0)
                        .map((b) => (
                          <CoverageBar
                            key={`${b.kind}-${b.level}`}
                            label={`${b.level} ${KIND_LABEL[b.kind].toLowerCase()}`}
                            total={b.total}
                            counts={b.counts}
                          />
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Why you miss
            </h2>
            <RootCauses data={rootCauses} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Weak points
            </h2>
            <WeakPoints items={weakItems} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Evidence volume
            </h2>
            <p className="text-xs text-neutral-400">Observations per week, last 8 weeks.</p>
            <EvidenceVolume weeks={db.evidenceWeeks} />
          </section>

          <IntegrationsPanel integrations={integrations} />
        </>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {children}
    </p>
  );
}
