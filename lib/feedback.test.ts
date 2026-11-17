import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  appendFeedbackBody,
  FEEDBACK_NOT_SET_UP,
  FEEDBACK_PREVIEW_CHARS,
  feedbackPeriod,
  isFeedbackStatus,
  isMissingTableError,
  MAX_FEEDBACK_BODY_CHARS,
  MIN_FEEDBACK_BODY_CHARS,
  normalizeSessionIds,
  parseFeedbackDate,
  planFeedbackUpdate,
  previewFeedback,
  validateFeedbackBody,
  validateFeedbackTitle,
  validateFeedbackUpdate,
  type FeedbackRowState,
} from "./feedback-core.ts";

const handoff = `JLPT Hub: feedback from the 2026-11-16 study session\n\n**What happened**\n${"Logged SKM L12 れんしゅう. ".repeat(12).trim()}`;
const now = new Date("2026-11-17T09:30:12Z");

test("validateFeedbackTitle: collapses whitespace, rejects empty and over-long", () => {
  assert.equal(validateFeedbackTitle("  JLPT Hub:\n feedback  "), "JLPT Hub: feedback");
  assert.throws(() => validateFeedbackTitle("   "), /title is empty/);
  assert.throws(() => validateFeedbackTitle("x".repeat(201)), /keep it under 200/);
});

test("validateFeedbackBody: trims, normalises CRLF, rejects empty, short and huge bodies", () => {
  assert.equal(validateFeedbackBody(`\r\n${handoff}\r\n\r\n`), handoff);
  assert.equal(validateFeedbackBody("a\r\nb".padEnd(MIN_FEEDBACK_BODY_CHARS + 5, "c")).includes("\r"), false);
  assert.throws(() => validateFeedbackBody(""), /body is empty/);
  assert.throws(() => validateFeedbackBody("   \n "), /body is empty/);
  assert.throws(() => validateFeedbackBody("Sessions logged: 3. Fix the tags."), /only 33 characters.*at least 200/);
  assert.equal(validateFeedbackBody("x".repeat(MIN_FEEDBACK_BODY_CHARS)).length, MIN_FEEDBACK_BODY_CHARS);
  assert.throws(() => validateFeedbackBody("x".repeat(MAX_FEEDBACK_BODY_CHARS + 1)), /the limit is 100000/);
});

test("parseFeedbackDate / feedbackPeriod: calendar dates, a lone date is one day, never reversed", () => {
  assert.equal(parseFeedbackDate(undefined, "period_from"), null);
  assert.equal(parseFeedbackDate(" 2026-11-16 ", "period_from"), "2026-11-16");
  assert.throws(() => parseFeedbackDate("2026-11-16T10:00", "period_from"), /period_from must be an ISO date/);
  assert.throws(() => parseFeedbackDate("2026-02-30", "period_to"), /period_to is not a calendar date/);
  assert.deepEqual(feedbackPeriod("2026-11-15", "2026-11-17"), { periodFrom: "2026-11-15", periodTo: "2026-11-17" });
  assert.deepEqual(feedbackPeriod("2026-11-16", undefined), { periodFrom: "2026-11-16", periodTo: "2026-11-16" });
  assert.deepEqual(feedbackPeriod(null, "2026-11-16"), { periodFrom: "2026-11-16", periodTo: "2026-11-16" });
  assert.deepEqual(feedbackPeriod(undefined, undefined), { periodFrom: null, periodTo: null });
  assert.throws(() => feedbackPeriod("2026-11-17", "2026-11-15"), /is after period_to/);
});

test("normalizeSessionIds: trimmed, lower-cased, de-duplicated in order", () => {
  assert.deepEqual(normalizeSessionIds(undefined), []);
  assert.deepEqual(normalizeSessionIds([" B91AAA65-0000-4000-8000-000000000001", "b91aaa65-0000-4000-8000-000000000001", "x", " "]), [
    "b91aaa65-0000-4000-8000-000000000001",
    "x",
  ]);
});

test("previewFeedback: whole body when short, cut at a boundary with an ellipsis when long", () => {
  assert.deepEqual(previewFeedback("short"), { chars: 5, preview: "short", truncated: false });
  const long = "word ".repeat(100);
  const p = previewFeedback(long);
  assert.equal(p.chars, 500);
  assert.equal(p.truncated, true);
  assert.ok(p.preview.endsWith("word…"));
  assert.ok(p.preview.length <= FEEDBACK_PREVIEW_CHARS + 1);
  // No boundary near the end: a hard cut.
  const solid = previewFeedback("あ".repeat(400));
  assert.equal(solid.preview, `${"あ".repeat(300)}…`);
  assert.equal(previewFeedback("x".repeat(300)).truncated, false);
});

test("appendFeedbackBody: dated rule, trimmed addition, rejects empty and over the limit", () => {
  const next = appendFeedbackBody("Body.\n\n", "  Also: 〜ために needs an alias.  ", now);
  assert.equal(next, "Body.\n\n---\n\n_Added 2026-11-17 09:30 UTC_\n\nAlso: 〜ために needs an alias.");
  assert.throws(() => appendFeedbackBody("Body.", " \n ", now), /append is empty/);
  assert.throws(() => appendFeedbackBody("x".repeat(MAX_FEEDBACK_BODY_CHARS - 10), "more text", now), /after the append/);
});

test("validateFeedbackUpdate: something to change, body xor append, known status", () => {
  assert.throws(() => validateFeedbackUpdate({}), /Nothing to change/);
  assert.throws(() => validateFeedbackUpdate({ body: handoff, append: "x" }), /not both/);
  assert.throws(() => validateFeedbackUpdate({ status: "closed" as never }), /status must be one of open, in_progress, done, dismissed/);
  assert.throws(() => validateFeedbackUpdate({ body: "too short" }), /only 9 characters/);
  assert.throws(() => validateFeedbackUpdate({ append: "  " }), /append is empty/);
  assert.doesNotThrow(() => validateFeedbackUpdate({ resolution: null }));
  assert.doesNotThrow(() => validateFeedbackUpdate({ status: "in_progress" }));
  assert.equal(isFeedbackStatus("dismissed"), true);
  assert.equal(isFeedbackStatus("closed"), false);
});

const row = (over: Partial<FeedbackRowState> = {}): FeedbackRowState => ({ status: "open", resolution: null, body: handoff, ...over });

test("planFeedbackUpdate: closing needs a resolution, given now or already stored", () => {
  assert.throws(() => planFeedbackUpdate(row(), { status: "done" }, now), /needs a resolution/);
  assert.throws(() => planFeedbackUpdate(row(), { status: "dismissed", resolution: "   " }, now), /needs a resolution/);
  assert.deepEqual(planFeedbackUpdate(row(), { status: "done", resolution: " PR #45 " }, now), {
    patch: { resolution: "PR #45", status: "done" },
    changed: ["resolution", "status"],
  });
  assert.deepEqual(planFeedbackUpdate(row({ resolution: "PR #45" }), { status: "done" }, now), {
    patch: { status: "done" },
    changed: ["status"],
  });
  // Clearing the stored resolution while closing is refused.
  assert.throws(() => planFeedbackUpdate(row({ resolution: "PR #45" }), { status: "done", resolution: null }, now), /needs a resolution/);
});

test("planFeedbackUpdate: any status can reopen; a resolution is kept unless cleared", () => {
  assert.deepEqual(planFeedbackUpdate(row({ status: "done", resolution: "PR #45" }), { status: "open" }, now), {
    patch: { status: "open" },
    changed: ["status"],
  });
  assert.deepEqual(planFeedbackUpdate(row({ status: "dismissed", resolution: "dup" }), { status: "in_progress", resolution: null }, now), {
    patch: { resolution: null, status: "in_progress" },
    changed: ["resolution", "status"],
  });
  assert.deepEqual(planFeedbackUpdate(row(), { status: "in_progress" }, now).changed, ["status"]);
});

test("planFeedbackUpdate: repeats are no-ops; body replaces; append adds", () => {
  assert.deepEqual(planFeedbackUpdate(row({ status: "done", resolution: "PR #45" }), { status: "done", resolution: "PR #45" }, now), {
    patch: {},
    changed: [],
  });
  assert.deepEqual(planFeedbackUpdate(row(), { body: `\n${handoff}\n` }, now), { patch: {}, changed: [] });
  const replaced = planFeedbackUpdate(row(), { body: `${handoff} edited` }, now);
  assert.deepEqual(replaced.changed, ["body"]);
  assert.equal(replaced.patch.body, `${handoff} edited`);
  const appended = planFeedbackUpdate(row(), { append: "One more gap: 〜ように." }, now);
  assert.deepEqual(appended.changed, ["body"]);
  assert.ok(appended.patch.body?.startsWith(handoff));
  assert.ok(appended.patch.body?.endsWith("_Added 2026-11-17 09:30 UTC_\n\nOne more gap: 〜ように."));
});

test("isMissingTableError: Postgres 42P01 for the table, through drizzle's cause chain", () => {
  const pg = Object.assign(new Error('relation "session_feedback" does not exist'), { code: "42P01" });
  assert.equal(isMissingTableError(pg, "session_feedback"), true);
  const wrapped = new Error("Failed query: insert into \"session_feedback\" ...", { cause: pg });
  assert.equal(isMissingTableError(wrapped, "session_feedback"), true);
  // Code without a message still counts; another table's 42P01 does not.
  assert.equal(isMissingTableError({ code: "42P01" }, "session_feedback"), true);
  const other = Object.assign(new Error('relation "vocab_queue" does not exist'), { code: "42P01" });
  assert.equal(isMissingTableError(other, "session_feedback"), false);
  assert.equal(isMissingTableError(new Error("DATABASE_URL is not set"), "session_feedback"), false);
  assert.equal(isMissingTableError("relation", "session_feedback"), false);
  assert.equal(isMissingTableError(null, "session_feedback"), false);
  assert.match(FEEDBACK_NOT_SET_UP, /not set up[^]*handoff as text/);
});

test("scripts/sql/session-feedback.sql: idempotent, additive, one table and its index", () => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "scripts", "sql", "session-feedback.sql"), "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS "session_feedback" \(/);
  assert.match(statements[1], /^CREATE INDEX IF NOT EXISTS "session_feedback_status" ON "session_feedback"/);
  assert.doesNotMatch(sql, /\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i);
  for (const col of ["id", "created_at", "title", "body", "status", "period_from", "period_to", "session_ids", "surface", "server_version", "resolution", "updated_at"]) {
    assert.match(statements[0], new RegExp(`"${col}" `), col);
  }
});
