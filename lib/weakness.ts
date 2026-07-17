import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { HALF_LIFE_DAYS } from "@/lib/mastery";
import type { ItemKind, JlptLevel } from "@/lib/types";

export interface WeakItem {
  itemId: string;
  headword: string;
  reading: string;
  kind: ItemKind;
  level: JlptLevel;
  /** 0..1, recency-decayed accuracy (same half-life-30d formula as lib/mastery.ts). */
  accuracy: number;
  answerCount: number;
}

type WeakItemQueryRow = Record<string, unknown> & {
  item_id: string;
  headword: string;
  reading: string;
  kind: string;
  level: string;
  acc: string | number;
  n: string | number;
};

export interface GetWeakItemsOptions {
  /** Minimum graded answers before an item is considered — too few is noise, not weakness. */
  minAnswers?: number;
  limit?: number;
}

/**
 * The N items with the worst recency-decayed answer accuracy, for the practice page's
 * "weak points" panel. Same decay formula as lib/mastery.ts's getMasteryMap (an answer
 * 30 days old counts half as much), scoped to kind='answer' observations only.
 */
export async function getWeakItems(opts: GetWeakItemsOptions = {}): Promise<WeakItem[]> {
  const minAnswers = opts.minAnswers ?? 3;
  const limit = opts.limit ?? 10;

  const res = await getDb().execute<WeakItemQueryRow>(sql`
    WITH ans AS (
      SELECT item_id,
             sum(CASE WHEN correct THEN w ELSE 0 END) / NULLIF(sum(w), 0) AS acc,
             count(*) AS n
      FROM (
        SELECT item_id, correct,
               exp(-ln(2.0) * extract(epoch FROM (now() - occurred_at)) / (86400.0 * ${sql.raw(String(HALF_LIFE_DAYS))})) AS w
        FROM observations
        WHERE kind = 'answer'
      ) decayed
      GROUP BY item_id
    )
    SELECT i.id AS item_id, i.headword, i.reading, i.kind, i.level, a.acc, a.n
    FROM ans a
    JOIN items i ON i.id = a.item_id
    WHERE a.n >= ${minAnswers}
    ORDER BY a.acc ASC
    LIMIT ${limit}
  `);

  return res.rows.map((row) => ({
    itemId: row.item_id,
    headword: row.headword,
    reading: row.reading,
    kind: row.kind as ItemKind,
    level: row.level as JlptLevel,
    accuracy: row.acc == null ? 0 : Number(row.acc),
    answerCount: Number(row.n),
  }));
}
