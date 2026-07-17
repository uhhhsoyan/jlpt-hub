import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { MasteryStatus } from "@/lib/types";

export interface MasteryEntry {
  itemId: string;
  /** 0..1; null when the only evidence is exposure with no graded signal yet. */
  score: number;
  status: MasteryStatus;
  observationCount: number;
}

/** Recency half-life for graded answers: an answer 30 days old counts half as much. */
const HALF_LIFE_DAYS = 30;

export function masteryStatus(score: number, observationCount: number): MasteryStatus {
  if (observationCount === 0) return "unseen";
  if (score > 0.85) return "mastered";
  if (score >= 0.6) return "solid";
  return "learning";
}

type MasteryQueryRow = Record<string, unknown> & {
  item_id: string;
  score: string | number | null;
  total: string | number;
};

/**
 * Mastery is computed at read time from the observations ledger (single-user scale —
 * a materialized score table can come later if this ever gets slow):
 * - answers: recency-decayed accuracy (half-life 30 days)
 * - srs_state: latest stage / 9 (WaniKani scale, 9 = burned)
 * - both present: 0.6 * answers + 0.4 * srs
 * - exposure only: a small floor that grows with sightings, capped at 0.3
 */
export async function getMasteryMap(): Promise<Map<string, MasteryEntry>> {
  const res = await getDb().execute<MasteryQueryRow>(sql`
    WITH ans AS (
      SELECT item_id,
             sum(CASE WHEN correct THEN w ELSE 0 END) / NULLIF(sum(w), 0) AS acc
      FROM (
        SELECT item_id, correct,
               exp(-ln(2.0) * extract(epoch FROM (now() - occurred_at)) / (86400.0 * ${sql.raw(String(HALF_LIFE_DAYS))})) AS w
        FROM observations
        WHERE kind = 'answer'
      ) decayed
      GROUP BY item_id
    ),
    srs AS (
      SELECT DISTINCT ON (item_id) item_id, srs_stage
      FROM observations
      WHERE kind = 'srs_state' AND srs_stage IS NOT NULL
      ORDER BY item_id, occurred_at DESC
    ),
    expo AS (
      SELECT item_id, count(*) AS n
      FROM observations
      WHERE kind = 'exposure'
      GROUP BY item_id
    ),
    totals AS (
      SELECT item_id, count(*) AS total FROM observations GROUP BY item_id
    )
    SELECT t.item_id,
           CASE
             WHEN a.acc IS NOT NULL AND s.srs_stage IS NOT NULL
               THEN 0.6 * a.acc + 0.4 * (s.srs_stage / 9.0)
             WHEN a.acc IS NOT NULL THEN a.acc
             WHEN s.srs_stage IS NOT NULL THEN s.srs_stage / 9.0
             ELSE least(0.3, 0.05 * coalesce(e.n, 0))
           END AS score,
           t.total
    FROM totals t
    LEFT JOIN ans a ON a.item_id = t.item_id
    LEFT JOIN srs s ON s.item_id = t.item_id
    LEFT JOIN expo e ON e.item_id = t.item_id
  `);

  const map = new Map<string, MasteryEntry>();
  for (const row of res.rows) {
    const count = Number(row.total);
    const score = row.score == null ? 0 : Number(row.score);
    map.set(row.item_id, {
      itemId: row.item_id,
      score,
      status: masteryStatus(score, count),
      observationCount: count,
    });
  }
  return map;
}
