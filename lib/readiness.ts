import { and, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { items } from "@/lib/db/schema";
import { getMasteryMap, type MasteryEntry } from "@/lib/mastery";
import { getAccuracyBySection, getMissesByRootCause, type RootCauseMisses, type SectionAccuracy } from "@/lib/weakness";
import type { ItemKind, JlptLevel, MasteryStatus } from "@/lib/types";

/** JLPT N4, Sunday Dec 6 2026 (also hard-coded in app/progress/exam-countdown.tsx). */
export const EXAM_DATE_ISO = "2026-12-06";

export const COVERAGE_KINDS: ItemKind[] = ["vocab", "kanji", "grammar"];
export const COVERAGE_LEVELS: JlptLevel[] = ["N5", "N4"];

export type CoverageCounts = Record<MasteryStatus, number>;

export interface CoverageBucket {
  kind: ItemKind;
  level: JlptLevel;
  total: number;
  counts: CoverageCounts;
}

function emptyCounts(): CoverageCounts {
  return { unseen: 0, learning: 0, solid: 0, mastered: 0 };
}

/** Buckets every N5/N4 vocab/kanji/grammar item by kind+level, joined against getMasteryMap(). */
export function buildCoverage(
  rows: { id: string; kind: ItemKind; level: JlptLevel }[],
  masteryMap: Map<string, MasteryEntry>,
): CoverageBucket[] {
  const buckets = new Map<string, CoverageBucket>();
  for (const kind of COVERAGE_KINDS) {
    for (const level of COVERAGE_LEVELS) {
      buckets.set(`${kind}-${level}`, { kind, level, total: 0, counts: emptyCounts() });
    }
  }
  for (const row of rows) {
    const bucket = buckets.get(`${row.kind}-${row.level}`);
    if (!bucket) continue;
    const status = masteryMap.get(row.id)?.status ?? "unseen";
    bucket.total += 1;
    bucket.counts[status] += 1;
  }
  return COVERAGE_KINDS.flatMap((kind) => COVERAGE_LEVELS.map((level) => buckets.get(`${kind}-${level}`)!));
}

/** Coverage buckets for the progress page and the readiness report (one mastery pass). */
export async function getCoverage(): Promise<CoverageBucket[]> {
  const db = getDb();
  const [itemRows, masteryMap] = await Promise.all([
    db
      .select({ id: items.id, kind: items.kind, level: items.level })
      .from(items)
      .where(and(inArray(items.kind, COVERAGE_KINDS), inArray(items.level, COVERAGE_LEVELS))),
    getMasteryMap(),
  ]);
  return buildCoverage(itemRows, masteryMap);
}

export interface ReadinessBucket extends CoverageBucket {
  /** Share of items with any evidence at all. */
  touchedPct: number;
  /** Share of items at solid or mastered. */
  readyPct: number;
}

export interface Readiness {
  examDate: string;
  daysToExam: number;
  coverage: ReadinessBucket[];
  overall: { total: number; touchedPct: number; readyPct: number };
  /** Trailing 30 days of confirmed practice. */
  recent: {
    windowDays: number;
    bySection: SectionAccuracy[];
    missesByRootCause: RootCauseMisses[];
  };
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** Inventory coverage × mastery × recent accuracy: the number the final weeks are managed by. */
export async function getReadiness(windowDays = 30): Promise<Readiness> {
  const [buckets, bySection, missesByRootCause] = await Promise.all([
    getCoverage(),
    getAccuracyBySection(windowDays),
    getMissesByRootCause(windowDays),
  ]);

  const coverage = buckets.map((b) => ({
    ...b,
    touchedPct: pct(b.total - b.counts.unseen, b.total),
    readyPct: pct(b.counts.solid + b.counts.mastered, b.total),
  }));
  const total = buckets.reduce((s, b) => s + b.total, 0);
  const touched = buckets.reduce((s, b) => s + (b.total - b.counts.unseen), 0);
  const ready = buckets.reduce((s, b) => s + b.counts.solid + b.counts.mastered, 0);

  const msPerDay = 86_400_000;
  const daysToExam = Math.ceil((Date.parse(EXAM_DATE_ISO) - Date.now()) / msPerDay);

  return {
    examDate: EXAM_DATE_ISO,
    daysToExam,
    coverage,
    overall: { total, touchedPct: pct(touched, total), readyPct: pct(ready, total) },
    recent: { windowDays, bySection, missesByRootCause },
  };
}
