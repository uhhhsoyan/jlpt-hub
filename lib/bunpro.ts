import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bpSnapshot, items, observations } from "@/lib/db/schema";
import { isIntegrationEnabled } from "@/lib/integrations";
import type { ItemDetail, ItemKind } from "@/lib/types";
import crosswalk from "@/data/seed/bunpro-crosswalk.json";

/**
 * Read-only Bunpro sync: pulls the user's grammar reviews from Bunpro's frontend
 * API and records the current SRS state as source='bunpro' observations, mirroring
 * the WaniKani sync (replace-on-sync, snapshot singleton, staleness lease).
 *
 * The frontend API is community-sanctioned but UNDOCUMENTED and has broken without
 * notice before (the official API was removed entirely in April 2026). Parsing is
 * therefore deliberately defensive: unrecognized response shapes fail the sync with
 * a "schema drift" message instead of writing garbage evidence.
 *
 * Auth: the long-lived API key from bunpro.jp/settings/api, sent as a Bearer token
 * with the dangerously_authenticate_using_api_token flag Bunpro added for exactly
 * this kind of integration.
 */

const BP_BASE = "https://api.bunpro.jp/api/frontend";
const AUTH_FLAG = "dangerously_authenticate_using_api_token=true";
const PER_PAGE = 100;
const MAX_PAGES = 200;
const PAGE_THROTTLE_MS = 200;

/** Bunpro SRS runs 1..12 (burned = done); our mastery math expects WaniKani's 0..9. */
const BP_MAX_STAGE = 12;
const WK_MAX_STAGE = 9;

/** A snapshot older than this is considered stale by the visit-triggered sync. */
const STALE_AFTER_MINUTES = 60;
/** How long a claimed-but-unfinished sync blocks new attempts (crash recovery). */
const LEASE_MINUTES = 10;

const BP_UNAUTHORIZED = "BP_UNAUTHORIZED";
const BP_RATE_LIMITED = "BP_RATE_LIMITED";

export type BpSyncResult =
  | {
      ok: true;
      summary: {
        reviewsSeen: number;
        grammarPointsMatched: number;
        itemsMapped: number;
        newlyMapped: number;
        observationsWritten: number;
        unmatchedPoints: number;
      };
    }
  | { ok: false; error: string };

interface CrosswalkPair {
  bunproId: number;
  bunproTitle: string;
  /** Curated grammar-item headword — stable across db reseeds, resolved to an id at sync time. */
  headword: string;
  method: string;
}

/** One review reduced to the fields the sync needs, whatever shape it arrived in. */
interface BpReview {
  grammarPointId: number;
  srsStage: number;
  burned: boolean;
  occurredAt: Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page: number, key: string): Promise<unknown> {
  const res = await fetch(
    `${BP_BASE}/reviews?page=${page}&per_page=${PER_PAGE}&${AUTH_FLAG}`,
    { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" },
  );
  if (res.status === 401 || res.status === 403) throw new Error(BP_UNAUTHORIZED);
  if (res.status === 429) throw new Error(BP_RATE_LIMITED);
  if (!res.ok) throw new Error(`Bunpro request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pull the array of review objects out of whichever envelope Bunpro used. */
function reviewListOf(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of ["data", "reviews"]) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
    // e.g. { data: { reviews: [...] } }
    if (isRecord(v) && Array.isArray(v.reviews)) return v.reviews;
  }
  return null;
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function dateField(obj: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/**
 * Reduce one raw review to BpReview, or null when it isn't a started grammar review.
 * JSON:API style ({id, attributes: {...}}) and flat objects are both accepted.
 */
function parseReview(raw: unknown): BpReview | null {
  if (!isRecord(raw)) return null;
  const attrs = isRecord(raw.attributes) ? raw.attributes : raw;

  // Vocab reviews exist too; only take rows that are (or point at) a grammar point.
  const type = attrs.reviewable_type ?? attrs.review_type;
  const grammarPointId =
    numberField(attrs, ["grammar_point_id"]) ??
    (typeof type === "string" && /grammar/i.test(type)
      ? numberField(attrs, ["reviewable_id"])
      : null);
  if (grammarPointId == null) return null;

  const srsStage = numberField(attrs, ["srs_stage", "srs_level", "streak"]);
  if (srsStage == null) return null;

  return {
    grammarPointId,
    srsStage,
    burned: attrs.burned === true,
    occurredAt:
      dateField(attrs, ["last_review", "last_reviewed_at", "updated_at", "created_at"]) ??
      new Date(),
  };
}

interface GrammarItemRow {
  id: string;
  headword: string;
  detail: ItemDetail | null;
}

/**
 * Resolve the committed crosswalk (data/seed/bunpro-crosswalk.json, built by
 * `npm run bunpro:crosswalk` — deterministic string pass + one-time Claude pass,
 * human-reviewable) against the current items table. Several Bunpro points may map
 * to one item (Bunpro splits patterns finer); the latest review per item wins.
 */
function buildCrosswalk(rows: GrammarItemRow[]): {
  itemIdByPointId: Map<number, string>;
  unmatchedPoints: number;
} {
  const itemIdByHeadword = new Map(rows.map((r) => [r.headword, r.id]));
  const itemIdByPointId = new Map<number, string>();
  let unmatchedPoints = 0;

  for (const pair of crosswalk.pairs as CrosswalkPair[]) {
    const itemId = itemIdByHeadword.get(pair.headword);
    if (itemId) itemIdByPointId.set(pair.bunproId, itemId);
    else unmatchedPoints++; // headword renamed/removed since the crosswalk was built
  }

  return { itemIdByPointId, unmatchedPoints };
}

function humanizeError(e: unknown): string {
  if (e instanceof Error) {
    if (e.message === BP_UNAUTHORIZED) {
      return "Bunpro rejected the API key — check that BUNPRO_API_KEY matches the key at bunpro.jp/settings/api.";
    }
    if (e.message === BP_RATE_LIMITED) {
      return "Bunpro rate limited the request — retry in a few minutes.";
    }
    if (/DATABASE_URL/.test(e.message)) {
      return "Database not configured — set DATABASE_URL in .env.local.";
    }
    const firstLine = e.message.split("\n")[0];
    return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  }
  return String(e);
}

export async function syncBunpro(): Promise<BpSyncResult> {
  const key = process.env.BUNPRO_API_KEY;
  if (!key) {
    return {
      ok: false,
      error:
        "BUNPRO_API_KEY is not set — copy the API key from bunpro.jp/settings/api " +
        "and add it to your environment.",
    };
  }
  if (!(await isIntegrationEnabled("bunpro"))) {
    return { ok: false, error: "The Bunpro integration is disabled — enable it below to sync." };
  }

  try {
    // Pull every review page. Stops on the first short/empty page.
    const rawReviews: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await sleep(PAGE_THROTTLE_MS);
      const list = reviewListOf(await fetchPage(page, key));
      if (list === null) {
        return {
          ok: false,
          error:
            "Bunpro returned an unrecognized response shape — their (undocumented) API " +
            "may have changed. No evidence was written.",
        };
      }
      rawReviews.push(...list);
      if (list.length < PER_PAGE) break;
    }

    const reviews = rawReviews.map(parseReview).filter((r): r is BpReview => r !== null);
    if (rawReviews.length > 0 && reviews.length === 0) {
      return {
        ok: false,
        error:
          "Bunpro returned reviews but none matched the expected fields — their " +
          "(undocumented) API may have changed. No evidence was written.",
      };
    }

    const db = getDb();
    const rows = await db
      .select({ id: items.id, headword: items.headword, detail: items.detail })
      .from(items)
      .where(inArray(items.kind, ["grammar"] satisfies ItemKind[]));

    const { itemIdByPointId, unmatchedPoints } = buildCrosswalk(rows);

    // Persist the mapping (merge-into-jsonb, same pattern as the WaniKani sync).
    const detailByItemId = new Map(rows.map((r) => [r.id, r.detail]));
    const newlyMapped = [...itemIdByPointId.entries()].filter(
      ([pointId, itemId]) => detailByItemId.get(itemId)?.bpGrammarPointId !== pointId,
    );
    if (newlyMapped.length > 0) {
      await db.$client.query(
        `UPDATE items AS i
         SET detail = coalesce(i.detail, '{}'::jsonb) || jsonb_build_object('bpGrammarPointId', v.bp_id)
         FROM (
           SELECT * FROM unnest($1::uuid[], $2::int[]) AS v(id, bp_id)
         ) AS v
         WHERE i.id = v.id`,
        [newlyMapped.map(([, itemId]) => itemId), newlyMapped.map(([pointId]) => pointId)],
      );
    }

    // Latest review per item (Bunpro can hold several rows per grammar point,
    // e.g. ghost reviews); the newest state is the one that matters.
    const latestByItemId = new Map<string, BpReview>();
    let grammarPointsMatched = 0;
    for (const review of reviews) {
      const itemId = itemIdByPointId.get(review.grammarPointId);
      if (!itemId) continue;
      grammarPointsMatched++;
      const current = latestByItemId.get(itemId);
      if (!current || review.occurredAt > current.occurredAt) {
        latestByItemId.set(itemId, review);
      }
    }

    const toInsert = [...latestByItemId.entries()].map(([itemId, review]) => ({
      itemId,
      source: "bunpro" as const,
      kind: "srs_state" as const,
      // Scale Bunpro's 1..12 onto WaniKani's 0..9 so mastery math stays uniform.
      srsStage: review.burned
        ? WK_MAX_STAGE
        : Math.max(0, Math.min(WK_MAX_STAGE, Math.round((review.srsStage * WK_MAX_STAGE) / BP_MAX_STAGE))),
      meta: {
        bpGrammarPointId: review.grammarPointId,
        bpSrsStage: review.srsStage,
        burned: review.burned,
      },
      occurredAt: review.occurredAt,
    }));

    // Replace-on-sync: Bunpro gives us current state, not history.
    await db.delete(observations).where(eq(observations.source, "bunpro"));
    if (toInsert.length > 0) await db.insert(observations).values(toInsert);

    const snapshotValues = {
      reviewsSeen: reviews.length,
      itemsMapped: itemIdByPointId.size,
      observationsWritten: toInsert.length,
      syncedAt: new Date(),
    };
    await db
      .insert(bpSnapshot)
      .values({ id: 1, ...snapshotValues })
      .onConflictDoUpdate({ target: bpSnapshot.id, set: snapshotValues });

    return {
      ok: true,
      summary: {
        reviewsSeen: reviews.length,
        grammarPointsMatched,
        itemsMapped: itemIdByPointId.size,
        newlyMapped: newlyMapped.length,
        observationsWritten: toInsert.length,
        unmatchedPoints,
      },
    };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}

/**
 * Visit-triggered background sync, same lease pattern as syncWanikaniIfStale:
 * refreshes an existing snapshot when it's over an hour old; the first-ever sync
 * goes through the Integrations panel so the mapping summary is visible.
 */
export async function syncBunproIfStale(): Promise<void> {
  if (!process.env.BUNPRO_API_KEY) return;
  try {
    if (!(await isIntegrationEnabled("bunpro"))) return;
    const db = getDb();
    const claimed = (await db.$client.query(
      `UPDATE bp_snapshot
       SET sync_started_at = now()
       WHERE id = 1
         AND synced_at < now() - ($1 * interval '1 minute')
         AND (sync_started_at IS NULL OR sync_started_at < now() - ($2 * interval '1 minute'))
       RETURNING id`,
      [STALE_AFTER_MINUTES, LEASE_MINUTES],
    )) as { rows?: unknown[] } | unknown[];
    const won = Array.isArray(claimed) ? claimed.length > 0 : (claimed.rows?.length ?? 0) > 0;
    if (!won) return;

    await syncBunpro();
  } catch {
    // Background freshness must never surface as a page error; the manual button
    // in the Integrations panel is the loud path.
  }
}
