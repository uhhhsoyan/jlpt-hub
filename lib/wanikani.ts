import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { items, observations, wkSnapshot } from "@/lib/db/schema";
import type { ItemKind, ItemDetail } from "@/lib/types";

const WK_BASE = "https://api.wanikani.com/v2";
const WK_REVISION = "20170710";

/** How many rows go into a single batched UPDATE / INSERT statement. */
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Minimal WaniKani API v2 envelope typing — only the fields this sync reads.
// ---------------------------------------------------------------------------

interface WkPage<T> {
  data: T[];
  pages: { next_url: string | null };
}

type WkSubjectObject = "kanji" | "vocabulary" | "kana_vocabulary";

interface WkSubjectReading {
  reading: string;
  primary: boolean;
}

interface WkSubject {
  id: number;
  object: WkSubjectObject;
  data: {
    characters: string | null;
    // Present for kanji/vocabulary only; kana_vocabulary has no separate reading
    // because the headword itself is the reading.
    readings?: WkSubjectReading[];
    // WaniKani level (1-60) the subject belongs to; used for level-up progress.
    level: number;
  };
}

interface WkUser {
  data: { level: number };
}

interface WkAssignment {
  // Sibling of `data`, not nested inside it — matches the shape of every WK resource.
  data_updated_at: string;
  data: {
    subject_id: number;
    srs_stage: number | null;
  };
}

interface WkReviewStatistic {
  data: {
    subject_id: number;
    percentage_correct: number;
  };
}

export type WkSyncResult =
  | {
      ok: true;
      summary: {
        subjectsFetched: number;
        itemsMapped: number;
        newlyMapped: number;
        assignmentsSeen: number;
        observationsWritten: number;
        unmatchedSubjects: number;
        level: number;
        kanjiPassed: number;
        kanjiRequired: number;
      };
    }
  | { ok: false; error: string };

/** Sentinel error messages thrown internally and translated by `humanizeError`. */
const WK_UNAUTHORIZED = "WK_UNAUTHORIZED";
const WK_RATE_LIMITED = "WK_RATE_LIMITED";

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  while (next) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Wanikani-Revision": WK_REVISION,
      },
      // This Next version leaves fetch uncached by default; the option is kept for
      // explicitness since this data must never be served from a cache.
      cache: "no-store",
    });
    if (res.status === 401) throw new Error(WK_UNAUTHORIZED);
    if (res.status === 429) throw new Error(WK_RATE_LIMITED);
    if (!res.ok) {
      throw new Error(`WaniKani request failed: ${res.status} ${res.statusText}`);
    }
    const page = (await res.json()) as WkPage<T>;
    out.push(...page.data);
    next = page.pages.next_url;
  }
  return out;
}

/** Fetch a single (non-collection) WK resource like /user. */
async function fetchOne<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Wanikani-Revision": WK_REVISION,
    },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error(WK_UNAUTHORIZED);
  if (res.status === 429) throw new Error(WK_RATE_LIMITED);
  if (!res.ok) {
    throw new Error(`WaniKani request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface MappedSubject {
  itemId: string;
  subjectId: number;
  alreadyMapped: boolean;
}

interface ItemForMatching {
  id: string;
  kind: ItemKind;
  headword: string;
  reading: string;
  detail: ItemDetail | null;
}

/**
 * Match one WK subject to at most one library item, per the rules in the sync spec:
 * - kanji: item kind='kanji' with the same headword.
 * - vocabulary: item kind='vocab' with the same headword AND a matching reading
 *   (primary WK reading preferred over non-primary); if no reading matches but
 *   exactly one vocab item has that headword, accept it anyway.
 * - kana_vocabulary: item kind='vocab' with the same headword (the word is already
 *   kana, so there's nothing else to disambiguate on).
 */
function matchSubject(
  subject: WkSubject,
  kanjiByHeadword: Map<string, ItemForMatching[]>,
  vocabByHeadword: Map<string, ItemForMatching[]>,
): ItemForMatching | undefined {
  const characters = subject.data.characters;
  if (!characters) return undefined;

  if (subject.object === "kanji") {
    // Kanji items are expected to be one row per headword; if duplicates somehow
    // exist we just take the first rather than fail the whole sync over it.
    return kanjiByHeadword.get(characters)?.[0];
  }

  const candidates = vocabByHeadword.get(characters) ?? [];
  if (candidates.length === 0) return undefined;

  if (subject.object === "kana_vocabulary") {
    return candidates[0];
  }

  // subject.object === "vocabulary"
  const readings = subject.data.readings ?? [];
  const primaryReadings = new Set(readings.filter((r) => r.primary).map((r) => r.reading));
  const anyReadings = new Set(readings.map((r) => r.reading));

  const byPrimary = candidates.find((c) => primaryReadings.has(c.reading));
  if (byPrimary) return byPrimary;

  const byAny = candidates.find((c) => anyReadings.has(c.reading));
  if (byAny) return byAny;

  // No reading lines up, but if the headword is unambiguous anyway, accept it.
  if (candidates.length === 1) return candidates[0];

  return undefined;
}

/** Single UPDATE per batch, merging `wkSubjectId` into existing detail jsonb without clobbering other keys. */
async function persistMapping(
  db: ReturnType<typeof getDb>,
  pairs: { itemId: string; subjectId: number }[],
): Promise<void> {
  for (const batch of chunk(pairs, BATCH_SIZE)) {
    const ids = batch.map((p) => p.itemId);
    const subjectIds = batch.map((p) => p.subjectId);
    // Drizzle's sql template expands a JS array into "($1, $2, …)" — an IN-list, not a
    // Postgres array — so unnest(${ids}::uuid[]) produced invalid SQL. Go through the raw
    // Neon client, which binds a JS array as ONE array parameter (the same pattern the
    // seed scripts use against this driver).
    await db.$client.query(
      `UPDATE items AS i
       SET detail = coalesce(i.detail, '{}'::jsonb) || jsonb_build_object('wkSubjectId', v.wk_subject_id)
       FROM (
         SELECT * FROM unnest($1::uuid[], $2::int[]) AS v(id, wk_subject_id)
       ) AS v
       WHERE i.id = v.id`,
      [ids, subjectIds],
    );
  }
}

function humanizeError(e: unknown): string {
  if (e instanceof Error) {
    if (e.message === WK_UNAUTHORIZED) {
      return "WaniKani rejected the token — check that WANIKANI_TOKEN is a valid personal access token.";
    }
    if (e.message === WK_RATE_LIMITED) {
      return "WaniKani rate limited the request — retry in a minute.";
    }
    if (/DATABASE_URL/.test(e.message)) {
      return "Database not configured — set DATABASE_URL in .env.local.";
    }
    // Driver errors can embed the full query text + parameters; keep the UI readable.
    const firstLine = e.message.split("\n")[0];
    return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  }
  return String(e);
}

/**
 * Pull kanji/vocabulary/kana_vocabulary subjects and assignments from WaniKani,
 * map them onto library items, and record the current SRS snapshot as observations.
 *
 * Assignments are a snapshot, not events: WaniKani doesn't give us history, so on
 * every sync we DELETE all prior source='wanikani' observations and re-insert the
 * latest one per mapped item. This means WK contributes no trend history (unlike
 * 'answer' observations from practice), only "where do things stand right now" —
 * which is all the API can tell us anyway.
 */
export async function syncWanikani(): Promise<WkSyncResult> {
  const token = process.env.WANIKANI_TOKEN;
  if (!token) {
    return {
      ok: false,
      error:
        "WANIKANI_TOKEN is not set — generate a personal access token at " +
        "https://www.wanikani.com/settings/personal_access_tokens and add it to your environment.",
    };
  }

  try {
    // Fetched first: cheap, and fails fast on a bad token before the big paginated pulls.
    const user = await fetchOne<WkUser>(`${WK_BASE}/user`, token);

    const subjects = await fetchAllPages<WkSubject>(
      `${WK_BASE}/subjects?types=kanji,vocabulary,kana_vocabulary&hidden=false`,
      token,
    );

    const db = getDb();
    const rows = await db
      .select({
        id: items.id,
        kind: items.kind,
        headword: items.headword,
        reading: items.reading,
        detail: items.detail,
      })
      .from(items)
      .where(inArray(items.kind, ["kanji", "vocab"] satisfies ItemKind[]));

    const kanjiByHeadword = new Map<string, ItemForMatching[]>();
    const vocabByHeadword = new Map<string, ItemForMatching[]>();
    for (const row of rows) {
      const map = row.kind === "kanji" ? kanjiByHeadword : vocabByHeadword;
      const list = map.get(row.headword);
      if (list) list.push(row);
      else map.set(row.headword, [row]);
    }

    const mapped: MappedSubject[] = [];
    let unmatchedSubjects = 0;

    for (const subject of subjects) {
      const item = matchSubject(subject, kanjiByHeadword, vocabByHeadword);
      if (!item) {
        unmatchedSubjects++;
        continue;
      }
      mapped.push({
        itemId: item.id,
        subjectId: subject.id,
        alreadyMapped: item.detail?.wkSubjectId === subject.id,
      });
    }

    const newlyMapped = mapped.filter((m) => !m.alreadyMapped);
    if (newlyMapped.length > 0) {
      await persistMapping(
        db,
        newlyMapped.map((m) => ({ itemId: m.itemId, subjectId: m.subjectId })),
      );
    }

    const assignments = await fetchAllPages<WkAssignment>(
      `${WK_BASE}/assignments?subject_types=kanji,vocabulary,kana_vocabulary`,
      token,
    );

    // Best-effort: review stats enrich the observation meta but aren't required for a sync to succeed.
    const percentageCorrectBySubject = new Map<number, number>();
    try {
      const stats = await fetchAllPages<WkReviewStatistic>(`${WK_BASE}/review_statistics`, token);
      for (const s of stats) {
        percentageCorrectBySubject.set(s.data.subject_id, s.data.percentage_correct);
      }
    } catch {
      // Ignore — the srs_state observations are still useful without percentage_correct.
    }

    const itemIdBySubject = new Map(mapped.map((m) => [m.subjectId, m.itemId]));

    const toInsert: (typeof observations.$inferInsert)[] = [];
    for (const a of assignments) {
      if (a.data.srs_stage == null) continue; // not started yet
      const itemId = itemIdBySubject.get(a.data.subject_id);
      if (!itemId) continue; // subject didn't map to a library item

      const meta: Record<string, unknown> = { wkSubjectId: a.data.subject_id };
      const pct = percentageCorrectBySubject.get(a.data.subject_id);
      if (pct != null) meta.percentageCorrect = pct;

      toInsert.push({
        itemId,
        source: "wanikani",
        kind: "srs_state",
        srsStage: a.data.srs_stage,
        meta,
        occurredAt: new Date(a.data_updated_at),
      });
    }

    // Replace-on-sync: see the doc comment above for why this is a delete + reinsert
    // rather than an append.
    await db.delete(observations).where(eq(observations.source, "wanikani"));
    for (const batch of chunk(toInsert, BATCH_SIZE)) {
      await db.insert(observations).values(batch);
    }

    // Level snapshot for the schedule: WK levels up once 90% of the current level's
    // kanji reach guru (srs_stage >= 5, i.e. "passed").
    const levelKanjiIds = new Set(
      subjects
        .filter((s) => s.object === "kanji" && s.data.level === user.data.level)
        .map((s) => s.id),
    );
    const kanjiTotal = levelKanjiIds.size;
    const kanjiPassed = assignments.filter(
      (a) => levelKanjiIds.has(a.data.subject_id) && (a.data.srs_stage ?? 0) >= 5,
    ).length;
    const kanjiRequired = Math.ceil(kanjiTotal * 0.9);
    const snapshotValues = {
      level: user.data.level,
      kanjiPassed,
      kanjiTotal,
      kanjiRequired,
      syncedAt: new Date(),
    };
    await db
      .insert(wkSnapshot)
      .values({ id: 1, ...snapshotValues })
      .onConflictDoUpdate({ target: wkSnapshot.id, set: snapshotValues });

    return {
      ok: true,
      summary: {
        subjectsFetched: subjects.length,
        itemsMapped: mapped.length,
        newlyMapped: newlyMapped.length,
        assignmentsSeen: assignments.length,
        observationsWritten: toInsert.length,
        unmatchedSubjects,
        level: user.data.level,
        kanjiPassed,
        kanjiRequired,
      },
    };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}
