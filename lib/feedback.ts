import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessionFeedback, type SessionFeedbackRow } from "@/lib/db/schema";
import { FEEDBACK_STATUSES, type FeedbackStatus, type PracticeSurface } from "@/lib/types";
import {
  FEEDBACK_NOT_SET_UP,
  FEEDBACK_TABLE,
  feedbackPeriod,
  isMissingTableError,
  normalizeSessionIds,
  planFeedbackUpdate,
  previewFeedback,
  validateFeedbackBody,
  validateFeedbackTitle,
  type FeedbackUpdateInput,
} from "@/lib/feedback-core";

export { FEEDBACK_STATUSES, previewFeedback, validateFeedbackUpdate } from "@/lib/feedback-core";

/**
 * The feedback inbox (session_feedback): the handoff a claude.ai study conversation files at
 * its end (send_feedback), read and closed later from Claude Code (get_feedback /
 * update_feedback, or `npm run feedback`). Private on purpose: the repo is public and this
 * is personal study data, so it lives in the Hub's database rather than in GitHub issues.
 * Validation lives in lib/feedback-core.ts and always runs before the first query.
 */

/** Runs a query; a missing table becomes the "not set up, give the handoff as text" error. */
async function withTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (isMissingTableError(e, FEEDBACK_TABLE)) throw new Error(FEEDBACK_NOT_SET_UP);
    throw e;
  }
}

export interface SendFeedbackInput {
  title: string;
  body: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  sessionIds?: string[];
  surface?: PracticeSurface;
  serverVersion: string;
}

export interface SendFeedbackResult {
  id: string;
  status: FeedbackStatus;
  createdAt: string;
  chars: number;
}

/** The validated row to insert; throws on bad input. Separate so the tool can check before the DB. */
export function prepareFeedback(input: SendFeedbackInput) {
  const title = validateFeedbackTitle(input.title);
  const body = validateFeedbackBody(input.body);
  const { periodFrom, periodTo } = feedbackPeriod(input.periodFrom, input.periodTo);
  return {
    title,
    body,
    periodFrom,
    periodTo,
    sessionIds: normalizeSessionIds(input.sessionIds),
    surface: input.surface ?? "claude-ai",
    serverVersion: input.serverVersion,
  };
}

export async function sendFeedback(input: SendFeedbackInput): Promise<SendFeedbackResult> {
  const values = prepareFeedback(input);
  const [row] = await withTable(() => getDb().insert(sessionFeedback).values(values).returning());
  return { id: row.id, status: row.status, createdAt: row.createdAt.toISOString(), chars: row.body.length };
}

export interface FeedbackView {
  id: string;
  title: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  periodFrom: string | null;
  periodTo: string | null;
  sessionIds: string[];
  surface: PracticeSurface;
  serverVersion: string;
  resolution: string | null;
  chars: number;
  /** Lists only, without include_body: the first ~300 characters. */
  preview?: string;
  body?: string;
}

export function feedbackView(row: SessionFeedbackRow, includeBody: boolean): FeedbackView {
  const { chars, preview } = previewFeedback(row.body);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    sessionIds: row.sessionIds,
    surface: row.surface,
    serverVersion: row.serverVersion,
    resolution: row.resolution,
    chars,
    ...(includeBody ? { body: row.body } : { preview }),
  };
}

export type FeedbackFilter = FeedbackStatus | "all";
export type FeedbackCounts = Record<FeedbackStatus, number>;

export async function getFeedbackById(id: string): Promise<SessionFeedbackRow> {
  const [row] = await withTable(() => getDb().select().from(sessionFeedback).where(eq(sessionFeedback.id, id)).limit(1));
  if (!row) throw new Error(`No feedback with id ${id}; list them with get_feedback (status all).`);
  return row;
}

/** Newest first. */
export async function listFeedback(opts: { status?: FeedbackFilter; limit?: number } = {}): Promise<SessionFeedbackRow[]> {
  const status = opts.status ?? "open";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return withTable(() => {
    const q = getDb().select().from(sessionFeedback);
    return status === "all"
      ? q.orderBy(desc(sessionFeedback.createdAt)).limit(limit)
      : q.where(eq(sessionFeedback.status, status)).orderBy(desc(sessionFeedback.createdAt)).limit(limit);
  });
}

export async function countFeedback(): Promise<FeedbackCounts> {
  const rows = await withTable(() =>
    getDb()
      .select({ status: sessionFeedback.status, n: sql<number>`count(*)::int` })
      .from(sessionFeedback)
      .groupBy(sessionFeedback.status),
  );
  const out = Object.fromEntries(FEEDBACK_STATUSES.map((s) => [s, 0])) as FeedbackCounts;
  for (const r of rows) if (r.status in out) out[r.status] = Number(r.n);
  return out;
}

export interface UpdateFeedbackResult {
  id: string;
  status: FeedbackStatus;
  resolution: string | null;
  chars: number;
  updatedAt: string;
  /** Fields that actually changed; empty when the call matched what was stored. */
  changed: string[];
}

export async function updateFeedback(id: string, input: FeedbackUpdateInput): Promise<UpdateFeedbackResult> {
  const row = await getFeedbackById(id);
  const { patch, changed } = planFeedbackUpdate(row, input, new Date());
  if (changed.length === 0) {
    return {
      id: row.id,
      status: row.status,
      resolution: row.resolution,
      chars: row.body.length,
      updatedAt: row.updatedAt.toISOString(),
      changed,
    };
  }
  const [next] = await withTable(() =>
    getDb()
      .update(sessionFeedback)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(sessionFeedback.id, id))
      .returning(),
  );
  return {
    id: next.id,
    status: next.status,
    resolution: next.resolution,
    chars: next.body.length,
    updatedAt: next.updatedAt.toISOString(),
    changed,
  };
}
