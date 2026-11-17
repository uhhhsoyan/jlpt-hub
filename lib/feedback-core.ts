import { FEEDBACK_STATUSES, type FeedbackStatus } from "./types.ts";

/**
 * Pure rules for the feedback inbox (session_feedback): validation, previews, append and
 * status changes. No DB and no path aliases, so it unit-tests under plain `node --test`;
 * lib/feedback.ts does the reads and writes and calls into this module before touching the DB.
 */

export { FEEDBACK_STATUSES, type FeedbackStatus };

/** A handoff shorter than this is a mistake (an empty call, a title pasted as the body). */
export const MIN_FEEDBACK_BODY_CHARS = 200;
/** Far above any real handoff (~5–15k characters); a guard against pasting a whole chat. */
export const MAX_FEEDBACK_BODY_CHARS = 100_000;
export const MAX_FEEDBACK_TITLE_CHARS = 200;
/** Characters of body shown per row in a list (get_feedback, `npm run feedback list`). */
export const FEEDBACK_PREVIEW_CHARS = 300;
/** Text added in one `append`; the whole body is still capped at MAX_FEEDBACK_BODY_CHARS. */
export const MIN_FEEDBACK_APPEND_CHARS = 1;

/** Statuses that close an item; moving to one needs a resolution (given now or already stored). */
export const CLOSED_FEEDBACK_STATUSES: readonly FeedbackStatus[] = ["done", "dismissed"];

export function isFeedbackStatus(v: string): v is FeedbackStatus {
  return (FEEDBACK_STATUSES as readonly string[]).includes(v);
}

export function validateFeedbackTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("title is empty; use 'JLPT Hub: feedback from the <dates> study session'.");
  if (t.length > MAX_FEEDBACK_TITLE_CHARS) {
    throw new Error(`title is ${t.length} characters; keep it under ${MAX_FEEDBACK_TITLE_CHARS} (the handoff itself goes in body).`);
  }
  return t;
}

/** Normalises line endings and trims; throws when the body is empty, too short or too long. */
export function validateFeedbackBody(raw: string): string {
  const b = raw.replace(/\r\n/g, "\n").trim();
  if (!b) throw new Error("body is empty; it must be the full feedback handoff in the format the instructions define.");
  if (b.length < MIN_FEEDBACK_BODY_CHARS) {
    throw new Error(
      `body is only ${b.length} characters; it must be the full feedback handoff (at least ${MIN_FEEDBACK_BODY_CHARS}), ` +
        "in the format the instructions define, not a summary line.",
    );
  }
  if (b.length > MAX_FEEDBACK_BODY_CHARS) {
    throw new Error(`body is ${b.length} characters; the limit is ${MAX_FEEDBACK_BODY_CHARS}. Trim it to the handoff itself.`);
  }
  return b;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that is a real calendar date, or null for absent input. */
export function parseFeedbackDate(raw: string | null | undefined, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (!s) return null;
  if (!ISO_DATE.test(s)) throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got "${raw}".`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`${field} is not a calendar date: "${raw}".`);
  }
  return s;
}

/** The study dates the feedback covers; a lone date is a one-day period, never a reversed one. */
export function feedbackPeriod(
  from: string | null | undefined,
  to: string | null | undefined,
): { periodFrom: string | null; periodTo: string | null } {
  const periodFrom = parseFeedbackDate(from, "period_from");
  const periodTo = parseFeedbackDate(to, "period_to");
  if (periodFrom && periodTo && periodFrom > periodTo) {
    throw new Error(`period_from (${periodFrom}) is after period_to (${periodTo}).`);
  }
  return { periodFrom: periodFrom ?? periodTo, periodTo: periodTo ?? periodFrom };
}

/** Ledger session ids, trimmed and de-duplicated in order. */
export function normalizeSessionIds(ids: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = raw.trim().toLowerCase();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface FeedbackPreview {
  chars: number;
  preview: string;
  truncated: boolean;
}

/** The first `max` characters, cut back to a word or line boundary when one is near, plus "…". */
export function previewFeedback(body: string, max = FEEDBACK_PREVIEW_CHARS): FeedbackPreview {
  const chars = body.length;
  if (chars <= max) return { chars, preview: body, truncated: false };
  let cut = body.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (boundary >= max * 0.8) cut = cut.slice(0, boundary);
  return { chars, preview: `${cut.trimEnd()}…`, truncated: true };
}

/**
 * Appends `addition` under a dated rule so a later reader can see what came after the first
 * filing. Throws when the addition is empty or the result exceeds the body limit.
 */
export function appendFeedbackBody(existing: string, addition: string, at: Date): string {
  const add = addition.replace(/\r\n/g, "\n").trim();
  if (add.length < MIN_FEEDBACK_APPEND_CHARS) throw new Error("append is empty.");
  const stamp = at.toISOString().slice(0, 16).replace("T", " ");
  const next = `${existing.trimEnd()}\n\n---\n\n_Added ${stamp} UTC_\n\n${add}`;
  if (next.length > MAX_FEEDBACK_BODY_CHARS) {
    throw new Error(`The body would be ${next.length} characters after the append; the limit is ${MAX_FEEDBACK_BODY_CHARS}.`);
  }
  return next;
}

export interface FeedbackUpdateInput {
  status?: FeedbackStatus;
  /** null clears it. */
  resolution?: string | null;
  /** Replaces the whole body. */
  body?: string;
  /** Text added to the end of the body. */
  append?: string;
}

export interface FeedbackRowState {
  status: FeedbackStatus;
  resolution: string | null;
  body: string;
}

export interface FeedbackPatch {
  status?: FeedbackStatus;
  resolution?: string | null;
  body?: string;
}

export interface FeedbackUpdatePlan {
  patch: FeedbackPatch;
  /** The fields that actually change: status, resolution, body. Empty means a no-op. */
  changed: ("status" | "resolution" | "body")[];
}

/** Checks an update_feedback call before any DB access: something to change, body xor append. */
export function validateFeedbackUpdate(input: FeedbackUpdateInput): void {
  const { status, resolution, body, append } = input;
  if (status === undefined && resolution === undefined && body === undefined && append === undefined) {
    throw new Error("Nothing to change: pass status, resolution, body and/or append.");
  }
  if (body !== undefined && append !== undefined) {
    throw new Error("Pass body (replace the whole handoff) or append (add to the end), not both.");
  }
  if (status !== undefined && !isFeedbackStatus(status)) {
    throw new Error(`status must be one of ${FEEDBACK_STATUSES.join(", ")}, got "${status}".`);
  }
  if (body !== undefined) validateFeedbackBody(body);
  if (append !== undefined && !append.trim()) throw new Error("append is empty.");
}

const cleanResolution = (r: string | null | undefined): string | null | undefined => {
  if (r === undefined || r === null) return r;
  const t = r.replace(/\r\n/g, "\n").trim();
  return t ? t : null;
};

/**
 * Works out what an update changes against the stored row. Any status can move to any other
 * (an item is reopened by setting open or in_progress), but closing one (done, dismissed)
 * needs a resolution, given in this call or already on the row, so the inbox says what
 * happened to every item. Same-value fields are left out of the patch, so a repeat is a no-op.
 */
export function planFeedbackUpdate(row: FeedbackRowState, input: FeedbackUpdateInput, now: Date): FeedbackUpdatePlan {
  validateFeedbackUpdate(input);
  const patch: FeedbackPatch = {};
  const changed: FeedbackUpdatePlan["changed"] = [];

  const resolution = cleanResolution(input.resolution);
  const nextResolution = resolution === undefined ? row.resolution : resolution;
  if (resolution !== undefined && resolution !== row.resolution) {
    patch.resolution = resolution;
    changed.push("resolution");
  }

  if (input.status !== undefined && input.status !== row.status) {
    if (CLOSED_FEEDBACK_STATUSES.includes(input.status) && !nextResolution) {
      throw new Error(
        `Marking feedback ${input.status} needs a resolution: what was done about it (PR numbers, commits) or why it needs nothing.`,
      );
    }
    patch.status = input.status;
    changed.push("status");
  }

  let nextBody: string | undefined;
  if (input.body !== undefined) nextBody = validateFeedbackBody(input.body);
  if (input.append !== undefined) nextBody = appendFeedbackBody(row.body, input.append, now);
  if (nextBody !== undefined && nextBody !== row.body) {
    patch.body = nextBody;
    changed.push("body");
  }

  return { patch, changed };
}

/**
 * Whether an error is Postgres "relation does not exist" (42P01) for `table`: the feedback
 * table has not been created in this database yet. Walks `cause`, since drizzle wraps the
 * driver's error.
 */
export function isMissingTableError(e: unknown, table: string): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === "object") {
      const err = cur as { code?: unknown; message?: unknown; cause?: unknown };
      const message = typeof err.message === "string" ? err.message : "";
      if (err.code === "42P01" && (!message || message.includes(table))) return true;
      if (message.includes(`relation "${table}" does not exist`)) return true;
      cur = err.cause;
    } else {
      return false;
    }
  }
  return false;
}

export const FEEDBACK_TABLE = "session_feedback";

export const FEEDBACK_NOT_SET_UP =
  "The feedback inbox is not set up in this database yet (table session_feedback is missing), so nothing was filed. " +
  "Give the learner the full handoff as text in the chat instead, so nothing is lost, and say the inbox needs " +
  "`npm run db:feedback-table` on the Hub side.";
