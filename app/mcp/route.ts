import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { bpSnapshot, wkSnapshot } from "@/lib/db/schema";
import {
  deleteInsight,
  getInsights,
  getInsightTagCounts,
  listSessions,
  logAttempts,
  logInsight,
  normalizeSection,
  queueVocabForAttempt,
  relinkUnresolved,
  updateAttempt,
  updateInsight,
  updateSession,
  type AttemptInput,
} from "@/lib/ledger";
import { memoryRecall, memoryReflect, readHindsightConfig } from "@/lib/hindsight";
import { getReadiness } from "@/lib/readiness";
import { findItemsBatch } from "@/lib/resolve-items";
import { getLessonReview } from "@/lib/lesson-review-db";
import { listStudySources, logStudy } from "@/lib/study-sources-db";
import { loadServedInstructions } from "@/lib/served-instructions";
import { countVocabQueue, effectiveAsMet, listVocabQueue, queueVocab, setVocabQueueStatus, type VocabGapInput } from "@/lib/vocab-queue";
import { assertNoReservedMetaKeys, normalizeSlips, parseDoneOn, SLIP_KINDS } from "@/lib/attempt-meta";
import { getAccuracyBySection, getMissesByRootCause, getPracticeWindow, getWeakItems } from "@/lib/weakness";
import { normalizeRootCause, ROOT_CAUSES, SESSION_MODES, STUDY_ACTIVITIES, VOCAB_QUEUE_STATUSES } from "@/lib/types";

/**
 * The study ledger's MCP endpoint (Streamable HTTP, stateless). One long random bearer
 * token in MCP_TOKEN gates every surface: the claude.ai custom connector, Claude Code's
 * .mcp.json, anything else. No token configured means nothing gets in.
 *
 * Stateless on purpose: Vercel functions can't hold an MCP session between requests,
 * and every tool here is a single request/response, so a fresh server per request is
 * both correct and cheap. JSON responses (not SSE) keep it simple for every client.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SERVER_INFO = { name: "jlpt-hub-study-ledger", version: "1.8.0" };

/**
 * Sent in the initialize result. Clients differ in whether the model ever sees it, so it is
 * a backup: the real mechanism is the project stub telling the model to call get_instructions.
 */
const SERVER_INSTRUCTIONS =
  "This is the JLPT Hub study ledger, the record of the learner's JLPT N4 preparation. " +
  "At the start of every conversation, before any other jlpt-hub tool, call get_instructions " +
  "and follow what it returns for the rest of the conversation.";

/** For sync_status: whether the Hindsight bridge is configured in this deployment (lib/hindsight.ts). */
function memoryStatus() {
  const cfg = readHindsightConfig();
  return cfg
    ? { configured: true, bank: cfg.bank, accessToken: !!(cfg.accessClientId && cfg.accessClientSecret), apiKey: !!cfg.apiKey }
    : { configured: false };
}

/**
 * The token is accepted two ways: `Authorization: Bearer <token>` (Claude Code's .mcp.json,
 * curl) or `x-api-key: <token>`. claude.ai's custom-connector form reserves the
 * Authorization header for its own OAuth flow, so that surface sends x-api-key.
 */
function presentedToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) return bearer[1];
  const apiKey = req.headers.get("x-api-key")?.trim();
  return apiKey ? apiKey : null;
}

function authorized(req: Request): boolean {
  const expected = process.env.MCP_TOKEN;
  if (!expected) return false;
  const token = presentedToken(req);
  if (!token) return false;
  const given = Buffer.from(token);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const SECTION_HINT =
  "kanji | vocab | grammar | reading | listening | other (moji/goi/bunpou/dokkai/choukai and 文字/語彙/文法/読解/聴解 also accepted)";

const tagSchema = z.object({
  kind: z.enum(["vocab", "kanji", "grammar"]),
  text: z
    .string()
    .describe(
      "Canonical form: dictionary form of a verb, a single bare kanji, or a grammar pattern like 〜ておく. Aliases and kana readings also resolve, and a tag filed under the wrong kind still matches if exactly one item fits; use find_items when unsure.",
    ),
});

const vocabGapSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe("The kanji / dictionary form, so the row links to a library item (dictionary form for verbs/adjectives): 続き, 間に合う, 大勢"),
  reading: z.string().optional().describe("Kana reading, e.g. つづき"),
  meaning: z.string().optional().describe("Short English gloss"),
  context: z.string().optional().describe("The phrase or sentence it stalled in; defaults to the attempt's note or stem"),
  as_met: z
    .string()
    .optional()
    .describe(
      "The form exactly as printed when it differs from text, e.g. おおぜい when the page printed kana for 大勢. Always fill it when the page printed kana; it goes on the front of the Anki card.",
    ),
});

type VocabGapArg = z.infer<typeof vocabGapSchema>;

/** Tool shape → lib shape (as_met → asMet). */
const toVocabGaps = (gaps: VocabGapArg[] | undefined): VocabGapInput[] | undefined =>
  gaps?.map(({ as_met, ...g }) => ({ ...g, asMet: as_met ?? null }));

const slipSchema = z.object({
  kind: z
    .string()
    .min(1)
    .describe(`Short kebab-case label; prefer one of: ${SLIP_KINDS.join(", ")}. Any other short label is kept (normalised like a root cause).`),
  text: z.string().min(1).describe("One line: 'read 時 as 時間', '〜ましょうか read as \"should we\", not an offer', 'gave the final verb to the listener'"),
});

const partSchema = z
  .number()
  .int()
  .positive()
  .describe("Blank of a multi-blank question: printed question 7 with blanks ① and ② is two attempts, number 7 part 1 and number 7 part 2");

const doneOnSchema = z
  .string()
  .describe("YYYY-MM-DD this attempt was done, only when it differs from the session's taken_at (a set spanning days); dates this attempt's item evidence only");

interface AttemptFieldArgs {
  number?: number;
  part?: number;
  done_on?: string;
  slips?: { kind: string; text: string }[];
  meta?: Record<string, unknown>;
}

/** Validate log_attempts' per-attempt first-class fields and keep them out of free meta. */
function attemptFields(a: AttemptFieldArgs, i: number): Pick<AttemptInput, "part" | "doneOn" | "slips"> {
  assertNoReservedMetaKeys(a.meta, `attempts[${i}].meta`);
  if (a.part !== undefined && a.number === undefined) {
    throw new Error(`attempts[${i}] has part ${a.part} but no number; a blank needs its printed question number.`);
  }
  return {
    part: a.part,
    doneOn: a.done_on === undefined ? undefined : (parseDoneOn(a.done_on) ?? undefined),
    slips: a.slips === undefined ? undefined : normalizeSlips(a.slips, `attempts[${i}].slips`),
  };
}

const attemptSchema = z.object({
  number: z.number().int().positive().optional().describe("Printed question number; defaults to position"),
  part: partSchema.optional(),
  done_on: doneOnSchema.optional(),
  section: z.string().describe(SECTION_HINT),
  level: z.enum(["N5", "N4"]).optional(),
  correct: z.boolean().nullable().describe("null if skipped or ungradable"),
  root_cause: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Why it was missed; omit for correct answers. Prefer one of: ${ROOT_CAUSES.join(", ")}. If none fits, use a short kebab-case label of your own; it is stored verbatim and reported under its own name.`,
    ),
  note: z.string().optional().describe("One-line diagnosis, e.g. 'picked つもり, needed はず'"),
  slips: z
    .array(slipSchema)
    .optional()
    .describe(
      "Non-pattern errors on this answer that do not decide correct: a word misread (時 as 時間), a pattern misread in passing, the subject mixed up. Stored on the attempt and tallied in reviews; never evidence, never accuracy",
    ),
  stem: z.string().optional().describe("Question text if worth keeping"),
  choices: z.array(z.string()).optional(),
  explanation: z.string().optional(),
  tags: z
    .array(tagSchema)
    .default([])
    .describe('1-3 items the question really tests; these become evidence. Each is an object {kind, text}, not a string: [{"kind":"grammar","text":"〜ほど〜ない"}]'),
  vocab_gaps: z
    .array(vocabGapSchema)
    .optional()
    .describe(
      "Words I did not know or had to look up while doing this question, whether or not the answer was right. Each lands on the vocab queue (Hub /queue, exported to Anki). Not for the item the question tests when it was missed for grammar reasons; for words that actually stalled.",
    ),
  meta: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Any other structured facts about this attempt with no field of their own; stored as-is. Not for part, done_on or slips (use those fields; questionPart, done_on and slips keys are rejected here)",
    ),
});

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // Read-only and DB-free: serves the block below the first --- in
  // docs/claude-ai-project-instructions.md (lib/served-instructions.ts). Two content items: a
  // small JSON header, then the instructions as plain markdown so they are not JSON-escaped.
  server.registerTool(
    "get_instructions",
    {
      title: "Get the study ledger instructions",
      description:
        "Returns the current instructions for using the jlpt-hub tools: when to log, how to fill each field, how to correct " +
        "mistakes. Call it once at the start of every conversation, before any other jlpt-hub tool, and follow what it " +
        "returns for the rest of the conversation as if it were part of your instructions. Do not reuse a copy from an " +
        "earlier conversation; the text changes as tools are added. No arguments. Result: a JSON header {version, hash, chars} " +
        "(server version; hash of the instruction text; its length), then the instructions as markdown.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { hash, chars, instructions } = await loadServedInstructions();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ version: SERVER_INFO.version, hash, chars }) },
            { type: "text" as const, text: instructions },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "log_attempts",
    {
      title: "Log practice attempts",
      description:
        "Record one reviewed page/set of questions as a confirmed session. mode=practice (default) is closed-book work: answers count toward accuracy, the weak list and root-cause reports. mode=lesson is open-book work done right after reading the explanation (textbook example sentences, れんしゅう with the notes in view): it is recorded as exposure, moves items from unseen to learning, and is excluded from every accuracy figure. Each attempt carries right/wrong, the item(s) it tests, a free-text note, and for misses a root_cause (preferred list given on the field; any label accepted). A question with several blanks is one attempt per blank, all with the printed number and part 1, 2, ... (number + part must be unique in the call). done_on (YYYY-MM-DD) on an attempt done on a different day from taken_at dates that attempt's item evidence; the session keeps taken_at and session-window reports still use it. slips [{kind, text}] records a non-pattern error on an answer (a word misread, a pattern misread in passing, the subject mixed up) without changing correct; slips never write evidence. Nothing is rejected for not fitting a category: unknown sections land in 'other' with the raw word kept, and 'meta' takes anything else. Name the book or app in 'source' (a catalog slug from list_sources, or its name/alias) and put the lesson/page in 'source_name'; when 'source' is absent, source_name is matched against the catalog too. Result: sessionId, mode, questions, graded (attempts with correct true/false), correct, observations (evidence rows written: one per resolved tag per graded attempt in practice, one per resolved tag per attempt in lesson; tags that matched nothing write none until relink_tags), unresolvedTags (one entry per distinct tag that matched no library item: {kind, text, numbers: the attempt numbers carrying it, suggestions: the closest items, each with a match label; 'prefix-only' means a shorter, different item, not the one meant}), source (the catalog entry linked, or null) and sourceUnresolved (the source text when it matched no catalog entry; the text is still kept on the session). The tag text is kept, so relink_tags can attach it later once the item or alias exists. A session logged with the wrong mode, label, date or source is fixed with update_session, not re-logged; a wrong tag, result, root cause or note on one attempt is fixed with update_attempt. For study time that produced no graded answers (reading, app reviews, listening), use log_study instead. Words the learner did not know while doing a question go in that attempt's vocab_gaps (right or wrong): text is the kanji / dictionary form for linking, as_met the form as printed when the page printed kana; each lands on the vocab queue (Hub /queue, Anki export) and vocabQueued in the result counts them. Words that stall outside a graded set go through queue_vocab.",
      inputSchema: {
        label: z.string().describe("e.g. '500問 Week 3 Day 2', 'Mock test 1 文法', 'SKM N4 L1 れんしゅう1'"),
        source: z
          .string()
          .optional()
          .describe("Slug or name/alias of a catalog source, e.g. 'skm-n4-bunpou', 'shin-nihongo-500-mon-n4-n5', 'Genki II'; see list_sources"),
        source_name: z
          .string()
          .optional()
          .describe("Free text kept on the session: the lesson/page detail when 'source' is given ('実力養成編 第1部 2課', 'L14'), or the book name when it is not"),
        taken_at: z.string().describe("ISO date or datetime the page was done, e.g. 2026-10-27"),
        surface: z.enum(["claude-ai", "claude-code", "hub"]).default("claude-ai"),
        mode: z
          .enum(SESSION_MODES)
          .default("practice")
          .describe("practice = closed book (counts); lesson = open book / just learned (exposure only)"),
        timed: z.boolean().optional().describe("Done under exam timing?"),
        image_refs: z.array(z.string()).optional().describe("Photo URLs or a text pointer to where they live"),
        attempts: z.array(attemptSchema).min(1),
      },
    },
    async (args) => {
      try {
        const takenAt = new Date(args.taken_at);
        if (Number.isNaN(takenAt.getTime())) throw new Error(`Unparseable taken_at: ${args.taken_at}`);

        const attempts: AttemptInput[] = args.attempts.map((a, i) => {
          const fields = attemptFields(a, i);
          // Never reject for an unrecognised category: fall back and keep the raw word.
          const section = normalizeSection(a.section) ?? "other";
          const meta: Record<string, unknown> = { ...(a.meta ?? {}) };
          if (section === "other" && normalizeSection(a.section) === null) meta.sectionRaw = a.section;
          return {
            number: a.number,
            ...fields,
            section,
            level: a.level ?? null,
            correct: a.correct,
            rootCause: normalizeRootCause(a.root_cause),
            note: a.note ?? null,
            stem: a.stem ?? null,
            choices: a.choices,
            explanation: a.explanation ?? null,
            tags: a.tags,
            meta,
            vocabGaps: toVocabGaps(a.vocab_gaps),
          };
        });

        const result = await logAttempts({
          label: args.label,
          source: args.source ?? null,
          sourceName: args.source_name ?? null,
          takenAt,
          surface: args.surface,
          mode: args.mode,
          timed: args.timed ?? null,
          imageRefs: args.image_refs,
          attempts,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "log_insight",
    {
      title: "Log a study insight",
      description:
        "Save a narrative note about a recurring pattern or belief, e.g. 'confuses どっち/どう under time pressure'. Tag it so it can be recalled by topic later, and name the library items it is about so get_insights finds it by item. Unmatched items are kept and attached later by relink_tags.",
      inputSchema: {
        text: z.string().min(1),
        tags: z.array(z.string()).default([]).describe("Short topic tags, e.g. ['particles', 'time-pressure']"),
        items: z
          .array(tagSchema)
          .optional()
          .describe('Library items the note is about, if any. Each is an object {kind, text}, not a string: [{"kind":"grammar","text":"〜ほど〜ない"}]'),
        source: z.enum(["claude-ai", "claude-code", "hub"]).default("claude-ai"),
      },
    },
    async (args) => {
      try {
        return ok(await logInsight(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_insights",
    {
      title: "Recall study insights",
      description:
        "Study notes, newest first. `topic` matches a linked library item (headword, alias, reading or pattern, e.g. 'ほど'), an exact tag, or the text; item and tag matches come first, text-only matches after, and each insight says which in matched: 'item' | 'tag' | 'text'. Discount 'text' hits: the topic may only appear inside another word (はず inside はずかしい). `tags` keeps only insights carrying every given tag (e.g. a pre-test review sheet: ['particles', 'polarity']). The full list of tags in use with counts (for reusing tag vocabulary when logging) comes back as `tags` only when include_tags is true, which is the default when neither topic nor tags is given. Result: {insights: [{id, text, tags, items, source, createdAt, matched?}], tags?: [{tag, n}]}.",
      inputSchema: {
        topic: z.string().optional(),
        tags: z.array(z.string().min(1)).max(10).optional().describe("AND-filter: insights carrying all of these tags"),
        include_tags: z
          .boolean()
          .optional()
          .describe("Also return every tag in use with counts; default true with no topic/tags filter, false otherwise"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const filtered = !!args.topic?.trim() || (args.tags?.length ?? 0) > 0;
        const includeTags = args.include_tags ?? !filtered;
        const [list, tags] = await Promise.all([
          getInsights({ topic: args.topic, tags: args.tags, limit: args.limit }),
          includeTags ? getInsightTagCounts() : Promise.resolve(null),
        ]);
        return ok(tags ? { insights: list, tags } : { insights: list });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_weakness_report",
    {
      title: "Weakness report",
      description:
        "What is going wrong, from closed-book practice only (lesson sessions never count). by=root_cause: misses grouped by cause over the window. by=section: accuracy per exam section over the window. by=item: the weakest library items by recency-decayed accuracy (window ignored; 30-day half-life). Windowed reports include a 'practice' block saying how many sessions fell in the window; if it is zero, widen window_days rather than concluding there is no data.",
      inputSchema: {
        by: z.enum(["root_cause", "section", "item"]).default("root_cause"),
        window_days: z.number().int().min(1).max(365).default(30),
        limit: z.number().int().min(1).max(100).default(15).describe("by=item only"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        if (args.by === "item") {
          return ok({ by: "item", items: await getWeakItems({ limit: args.limit }) });
        }
        const practice = await getPracticeWindow(args.window_days);
        if (args.by === "section") {
          return ok({ by: "section", windowDays: args.window_days, practice, sections: await getAccuracyBySection(args.window_days) });
        }
        return ok({
          by: "root_cause",
          windowDays: args.window_days,
          practice,
          causes: await getMissesByRootCause(args.window_days),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // A tool of its own rather than a mode of get_weakness_report, so that report's
  // "closed-book practice only" contract has no switch that could mix lesson scores in.
  server.registerTool(
    "get_lesson_review",
    {
      title: "Lesson review",
      description:
        "What I missed or stumbled on in open-book lesson sessions (mode=lesson), for review before a closed-book まとめ test. get_weakness_report deliberately ignores lessons; this is the lesson-side view. Read-only: it never changes or feeds any accuracy figure. Pick lessons with source (catalog slug, e.g. skm-n4-bunpou) plus lesson_from/lesson_to (lesson numbers read from the label, 'SKM N4 L12 れんしゅう2', or source_name, '12課'), and optionally match (substring of label or source_name, e.g. 'れんしゅう') and a date range. Result: {selection, sessions: [{sessionId, label, source, sourceName, lesson, takenAt, score: {correct, graded, questions}, review: [{number, correct, rootCause?, note?, tags: [text], unlinked?: [text], meta?}]}], summary: {sessions, questions, graded, correct, missed, slips, notAttempted, missesByRootCause: [{rootCause, known, misses}], repeatedMisses: [{text, kind, itemId, misses, where}]}, truncated?, hint?}. review lists every attempt that was wrong (correct false), not attempted (null), or right with a note (a slip worth revisiting); clean right answers are only counted in score. Empty fields are omitted; unlinked lists the tags that matched no library item. repeatedMisses are the items (or unlinked tag texts) missed more than once across the selection, with where each miss was ('<label> #<number>'). Stems, choices and explanations are left out unless include_text is set.",
      inputSchema: {
        source: z.string().min(1).optional().describe("Catalog source slug, name or alias, e.g. 'skm-n4-bunpou'; omit for every source"),
        lesson_from: z.number().int().min(0).optional().describe("First lesson number, inclusive"),
        lesson_to: z.number().int().min(0).optional().describe("Last lesson number, inclusive"),
        match: z.string().min(1).optional().describe("Case-insensitive substring of the session label or source_name, e.g. 'れんしゅう', 'L12'"),
        since: z.string().optional().describe("ISO date: sessions taken on or after"),
        until: z.string().optional().describe("ISO date: sessions taken on or before (the whole day)"),
        window_days: z.number().int().min(1).max(365).optional().describe("Instead of since: the last N days"),
        limit: z.number().int().min(1).max(100).default(30).describe("Max sessions; the most recent are kept"),
        include_text: z.boolean().default(false).describe("Add stored stem, choices and explanation to each reviewed attempt"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        if (args.since !== undefined && args.window_days !== undefined) throw new Error("Pass since or window_days, not both.");
        if (args.lesson_from !== undefined && args.lesson_to !== undefined && args.lesson_from > args.lesson_to) {
          throw new Error(`lesson_from (${args.lesson_from}) is after lesson_to (${args.lesson_to}).`);
        }
        let since: Date | null = null;
        if (args.since !== undefined) {
          since = new Date(args.since);
          if (Number.isNaN(since.getTime())) throw new Error(`Unparseable since: ${args.since}`);
        } else if (args.window_days !== undefined) {
          since = new Date(Date.now() - args.window_days * 86_400_000);
        }
        let until: Date | null = null;
        if (args.until !== undefined) {
          until = new Date(args.until);
          if (Number.isNaN(until.getTime())) throw new Error(`Unparseable until: ${args.until}`);
          // A bare date means through the end of that day.
          if (/^\d{4}-\d{2}-\d{2}$/.test(args.until.trim())) until = new Date(until.getTime() + 86_400_000);
        }
        const review = await getLessonReview({
          source: args.source ?? null,
          lessonFrom: args.lesson_from ?? null,
          lessonTo: args.lesson_to ?? null,
          match: args.match ?? null,
          since,
          until,
          limit: args.limit,
          includeText: args.include_text,
        });
        // Compact JSON: five lessons run to ~100 reviewed attempts and indentation alone nearly doubles that.
        return { content: [{ type: "text" as const, text: JSON.stringify(review) }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_readiness",
    {
      title: "N4 readiness",
      description:
        "Days to the exam, inventory coverage per kind and level (unseen/learning/solid/mastered), and the trailing window of closed-book practice: accuracy by section and misses by root cause, with a 'practice' block saying how many sessions the window holds (widen window_days if zero).",
      inputSchema: { window_days: z.number().int().min(1).max(365).default(30) },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return ok(await getReadiness(args.window_days));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_items",
    {
      title: "Find library items",
      description:
        "Look up library items by headword, alias, kana reading, grammar pattern or English meaning, ranked by closeness. Use it before tagging when unsure of the canonical form, and to check whether an item exists at all. Pass `queries` (up to 25) instead of `query` to check several forms in one call, e.g. every pattern of a lesson before starting it. English is matched word by word against the gloss ('must, have to', 'because, reason te-form'), and a Japanese word in a mixed query is matched against forms ('conditional と'). Each result has resolves: {id, headword} when the text, used as a tag as-is (with `kind` as the tag kind), would link to that item, or null when it would stay unresolved; and items, each hit carrying match: exact (the same form, tildes and spacing aside), exact-loose (equal only once a sense label in parentheses is dropped: the particle と for 〜と（条件）, or から（理由）/から（起点） for a bare から, so not necessarily the one meant), extends (the item is a longer form of the query), contains, meaning (by the query's words, best coverage first), or prefix-only (the item is merely a prefix of the query, e.g. まで for 〜までに: a different, shorter item, so an unresolved tag is still unresolved). Result: {query, resolves, items} for `query`, {results: [{query, resolves, items}]} for `queries`.",
      inputSchema: {
        query: z.string().min(1).optional().describe("e.g. 'ほど', 'いちばん', 'black tea', '〜と〜とどちら', 'conditional と'"),
        queries: z
          .array(z.string().min(1))
          .min(1)
          .max(25)
          .optional()
          .describe("Several lookups in one call instead of `query`, e.g. ['〜ばかり', '〜たところ', '〜ようになる']"),
        kind: z.enum(["vocab", "kanji", "grammar"]).optional().describe("Prefer this kind in the ranking, and resolve as a tag of this kind"),
        limit: z.number().int().min(1).max(25).optional().describe("Hits per query; default 8 for `query`, 3 per query for `queries`"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        if ((args.query === undefined) === (args.queries === undefined)) {
          throw new Error("Pass exactly one of `query` (one lookup) or `queries` (up to 25).");
        }
        const kind = args.kind ?? null;
        if (args.queries) {
          return ok({ results: await findItemsBatch(args.queries, { kind, limit: args.limit ?? 3 }) });
        }
        const [result] = await findItemsBatch([args.query as string], { kind, limit: args.limit ?? 8 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "relink_tags",
    {
      title: "Relink unresolved tags",
      description:
        "Re-run item resolution over every stored attempt tag and insight item that matched nothing when logged, and attach the missing evidence (dated by the attempt's done_on when it has one, else the session's taken_at). Also links vocab-queue rows that have no library item yet, by text then reading, as when they were queued; an existing link is never changed. Idempotent and safe to run any time; run it after an item or alias is added to the library. Result: {questionsChecked, tagsRelinked, observations, insightsChecked, insightItemsRelinked, stillUnresolved: [{kind, text, n, suggestions}], queueLinked, queueUnlinked: [text], invalidDoneOn?: attempts skipped because their stored done_on is not a date (fix with update_attempt done_on)}.",
      inputSchema: {},
      annotations: { idempotentHint: true },
    },
    async () => {
      try {
        return ok(await relinkUnresolved());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "Recent sessions",
      description: "The most recently logged sessions (practice and lesson) with their scores, to check what is already in the ledger.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return ok(await listSessions(args.limit));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_session",
    {
      title: "Correct a logged session",
      description:
        "Fix a session that was logged with the wrong mode, label, taken_at or source, instead of re-logging it. Pass only the fields to change. Changing mode or taken_at rebuilds the session's evidence rows (answers become exposures when it turns into a lesson, and back); questions, tags, notes and insights are untouched. Use list_sessions to find the id.",
      inputSchema: {
        session_id: z.string().uuid(),
        mode: z.enum(SESSION_MODES).optional().describe("practice (closed book, counts) or lesson (open book, exposure only)"),
        label: z.string().min(1).optional(),
        taken_at: z.string().optional().describe("ISO date or datetime the work was done"),
        source: z
          .string()
          .min(1)
          .optional()
          .describe("Catalog source to link (slug, name or alias; see list_sources), or 'none' to unlink"),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        let takenAt: Date | undefined;
        if (args.taken_at !== undefined) {
          takenAt = new Date(args.taken_at);
          if (Number.isNaN(takenAt.getTime())) throw new Error(`Unparseable taken_at: ${args.taken_at}`);
        }
        if (args.mode === undefined && args.label === undefined && takenAt === undefined && args.source === undefined) {
          throw new Error("Nothing to change: pass mode, label, taken_at and/or source.");
        }
        return ok(
          await updateSession({ sessionId: args.session_id, mode: args.mode, label: args.label, takenAt, source: args.source }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- Corrections to logged rows (lib/ledger.ts updateAttempt / updateInsight / deleteInsight).
  server.registerTool(
    "update_attempt",
    {
      title: "Correct a logged attempt",
      description:
        "Fix one attempt of a logged session in place, instead of re-logging the set or leaving a wrong tag for an alias to absorb. Name it by session_id (list_sessions), its printed number and, for one blank of a multi-blank question, its part. If number (+ part) still matches several attempts, the call fails and lists the candidates with their part and position; call again with part or position (1-based order in the session). Pass only the fields to change. tags replaces the whole tag list (objects {kind, text}, re-resolved) and rebuilds the attempt's evidence; changing correct or done_on also rebuilds it under the session's mode. root_cause, note, stem and explanation take null to clear (a root_cause is not cleared automatically when correct turns true; pass root_cause: null as well). done_on (YYYY-MM-DD, null clears) dates this attempt's evidence. slips replaces the attempt's slips ([] clears); slips never touch evidence. new_number and new_part (null clears) renumber the attempt, e.g. to turn an old workaround (a shifted number with meta.printed/meta.blank) into number + part; two attempts may not share the same number and part. meta is merged shallowly: keys given overwrite, a key set to null is removed, keys not mentioned are kept (questionPart, done_on and slips keys are rejected: use the fields). vocab_gaps adds words to the vocab queue tied to this question (same as on log_attempts); it never removes queue rows. Result: {sessionId, mode, attempt: {questionId, position, number, part, doneOn, slips, section, correct, rootCause, note, stem, explanation, tags: [{kind, text, itemId}], meta}, changed: the fields that actually changed (tags, correct, root_cause, note, stem, explanation, number, part, done_on, slips, meta), observations: {removed, written} for this attempt (null unless tags, correct or done_on changed), unresolvedTags (grouped as in log_attempts), vocabQueued}.",
      inputSchema: {
        session_id: z.string().uuid(),
        number: z.number().int().positive().describe("Printed question number of the attempt"),
        part: partSchema.optional().describe("Part (blank) of the attempt to fix, for a multi-blank question"),
        position: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based order in the session; only needed when number (+ part) still matches several attempts (the error lists them)"),
        new_number: z.number().int().positive().optional().describe("Renumber the attempt to this printed number"),
        new_part: partSchema.nullable().optional().describe("Set the attempt's part (blank); null clears it"),
        done_on: doneOnSchema.nullable().optional().describe("YYYY-MM-DD the attempt was done if not the session's taken_at; null clears. Rebuilds its evidence"),
        slips: z.array(slipSchema).optional().describe("Replaces the attempt's slips; [] clears them"),
        tags: z
          .array(tagSchema)
          .optional()
          .describe('Replaces the tag list. Objects {kind, text}, not strings: [{"kind":"grammar","text":"〜ないで"}]'),
        correct: z.boolean().nullable().optional().describe("null if skipped or ungradable"),
        root_cause: z
          .string()
          .nullable()
          .optional()
          .describe(`null clears it. Prefer one of: ${ROOT_CAUSES.join(", ")}; any short kebab-case label is kept.`),
        note: z.string().nullable().optional().describe("Replaces the note; null clears it"),
        stem: z.string().nullable().optional().describe("Replaces the stem; null clears it"),
        explanation: z.string().nullable().optional().describe("Replaces the explanation; null clears it"),
        meta: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Merged shallowly into the attempt's meta; a key set to null is removed"),
        vocab_gaps: z.array(vocabGapSchema).optional().describe("Words to add to the vocab queue, tied to this question"),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        const nothing =
          args.tags === undefined &&
          args.correct === undefined &&
          args.root_cause === undefined &&
          args.note === undefined &&
          args.stem === undefined &&
          args.explanation === undefined &&
          args.meta === undefined &&
          args.new_number === undefined &&
          args.new_part === undefined &&
          args.done_on === undefined &&
          args.slips === undefined &&
          (args.vocab_gaps === undefined || args.vocab_gaps.length === 0);
        if (nothing) {
          throw new Error(
            "Nothing to change: pass tags, correct, root_cause, note, stem, explanation, done_on, slips, new_number, new_part, meta and/or vocab_gaps.",
          );
        }
        assertNoReservedMetaKeys(args.meta);
        return ok(
          await updateAttempt({
            sessionId: args.session_id,
            number: args.number,
            part: args.part,
            position: args.position,
            newNumber: args.new_number,
            newPart: args.new_part,
            doneOn: args.done_on === undefined ? undefined : parseDoneOn(args.done_on),
            slips: args.slips === undefined ? undefined : normalizeSlips(args.slips),
            tags: args.tags,
            correct: args.correct,
            rootCause: args.root_cause === undefined ? undefined : normalizeRootCause(args.root_cause),
            note: args.note,
            stem: args.stem,
            explanation: args.explanation,
            meta: args.meta,
            vocabGaps: toVocabGaps(args.vocab_gaps),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_insight",
    {
      title: "Correct a logged insight",
      description:
        "Fix an insight in place instead of logging a near-duplicate (find the id with get_insights). Pass only the fields to change: text replaces the text, tags replaces the topic tags, items replaces the item references (objects {kind, text}, re-resolved; unmatched ones are kept and linked later by relink_tags, as in log_insight). The memory graph (memory_recall) keeps the version it already mirrored. Result: {id, text, tags, items: [{kind, text, itemId}], changed: the fields that actually changed, linkedItems, unresolvedItems (each with suggestions)}.",
      inputSchema: {
        insight_id: z.string().uuid(),
        text: z.string().min(1).optional(),
        tags: z.array(z.string()).optional().describe("Replaces the topic tags"),
        items: z
          .array(tagSchema)
          .optional()
          .describe('Replaces the item references. Objects {kind, text}, not strings: [{"kind":"grammar","text":"〜はず"}]'),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        if (args.text === undefined && args.tags === undefined && args.items === undefined) {
          throw new Error("Nothing to change: pass text, tags and/or items.");
        }
        return ok(await updateInsight({ id: args.insight_id, text: args.text, tags: args.tags, items: args.items }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_insight",
    {
      title: "Delete an insight",
      description:
        "Permanently delete an insight and its item links. Use it only when I ask for an insight to be removed; to fix a wrong or incomplete one, use update_insight. The memory graph (memory_recall) keeps its mirrored copy. Result: {deleted: {id, text, tags, items, createdAt}}; repeat the text back so I can see what went.",
      inputSchema: {
        insight_id: z.string().uuid(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        return ok(await deleteInsight(args.insight_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "Study source catalog",
      description:
        "The catalog of books, question banks, official workbooks and apps the learner studies from, with how each is meant to be used (howUsed: which mode or tool to log it with) and usage so far: sessions (practice and lesson counts, last date) and study-log minutes. Use it to pick the 'source' slug for log_attempts, update_session and log_study, and to see which sources are going untouched. Inactive sources are hidden unless include_inactive is set.",
      inputSchema: {
        include_inactive: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const sources = await listStudySources({ includeInactive: args.include_inactive });
        return ok({
          sources: sources.map((s) => ({
            slug: s.slug,
            name: s.name,
            nameJa: s.nameJa,
            kind: s.kind,
            level: s.level,
            description: s.description,
            howUsed: s.howUsed,
            ...(s.active ? {} : { active: false }),
            sessions: s.stats.sessions,
            practiceSessions: s.stats.practiceSessions,
            lessonSessions: s.stats.lessonSessions,
            lastSessionAt: s.stats.lastSessionAt,
            studyLogEntries: s.stats.logEntries,
            studyMinutes: s.stats.minutes,
            lastStudyLogAt: s.stats.lastLogAt,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "log_study",
    {
      title: "Log study time",
      description:
        "Record time-based study that produced no graded questions: 30 minutes of reading in Satori Reader, a WaniKani or Bunpro review session, a listening pass, reading a textbook chapter without doing its exercises. It writes a study-log entry against a catalog source (no item evidence: app answers arrive through their own syncs, and graded work belongs in log_attempts). Use it once per sitting, after the fact. Errors if the source does not match a catalog entry, listing the valid slugs. Returns the entry id, the source linked, activity, minutes and taken_at.",
      inputSchema: {
        source: z.string().min(1).describe("Catalog source: slug, name or alias, e.g. 'satori-reader', 'wanikani', 'Genki II'; see list_sources"),
        activity: z
          .enum(STUDY_ACTIVITIES)
          .describe("reading | listening | review (SRS reviews) | lesson (read the explanation, no exercises) | drill | other"),
        minutes: z.number().int().min(0).max(24 * 60).optional().describe("How long, if known"),
        taken_at: z.string().describe("ISO date or datetime the study was done, e.g. 2026-11-04"),
        note: z.string().optional().describe("What was read/reviewed, e.g. 'Satori: Kiki-Mimi Radio ep. 3', 'WK level 12 reviews, 85%'"),
        meta: z.record(z.string(), z.unknown()).optional().describe("Any structured facts with no field of their own; stored as-is"),
        surface: z.enum(["claude-ai", "claude-code", "hub"]).default("claude-ai"),
      },
    },
    async (args) => {
      try {
        const takenAt = new Date(args.taken_at);
        if (Number.isNaN(takenAt.getTime())) throw new Error(`Unparseable taken_at: ${args.taken_at}`);
        return ok(
          await logStudy({
            source: args.source,
            activity: args.activity,
            minutes: args.minutes ?? null,
            takenAt,
            note: args.note ?? null,
            meta: args.meta ?? null,
            surface: args.surface,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sync_status",
    {
      title: "External sync status",
      description: "When WaniKani and Bunpro were last pulled, and whether each is configured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const db = getDb();
        const [wk, bp] = await Promise.all([db.select().from(wkSnapshot), db.select().from(bpSnapshot)]);
        return ok({
          memory: memoryStatus(),
          wanikani: {
            configured: !!process.env.WANIKANI_TOKEN,
            syncedAt: wk[0]?.syncedAt.toISOString() ?? null,
            level: wk[0]?.level ?? null,
            kanjiPassed: wk[0]?.kanjiPassed ?? null,
            kanjiRequired: wk[0]?.kanjiRequired ?? null,
          },
          bunpro: {
            configured: !!process.env.BUNPRO_API_KEY,
            syncedAt: bp[0]?.syncedAt.toISOString() ?? null,
            reviewsSeen: bp[0]?.reviewsSeen ?? null,
            itemsMapped: bp[0]?.itemsMapped ?? null,
          },
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- Vocab queue (lib/vocab-queue.ts): words the learner did not know, for Anki later.
  server.registerTool(
    "queue_vocab",
    {
      title: "Queue unknown vocab",
      description:
        "Put words I did not know (or had to look up) on the vocab queue, for words met outside a graded set: reading, a lesson explanation, listening, a chat exchange. For words that stalled on a question being logged now, use the attempt's vocab_gaps in log_attempts instead. For a word noticed after its set was logged, pass session_id and number (plus part for one blank of a multi-blank question, and position only if that still repeats): the word is tied to that question exactly as an attempt's vocab_gap would be (the session's date and label, the question's note or stem as default context), and the result also carries attempt: {sessionId, questionId, number, part, position}. text is the kanji / dictionary form (it links the row to a library item); as_met is the form as printed when it differs, e.g. おおぜい for 大勢: always fill it when the page printed kana. One row per word; a repeat bumps its count and keeps the new context. Result: {queued, bumped, words:[{id,text,status,seenCount,itemId,asMet,created}]}; asMet is the row's most recent as-met form. The queue is reviewed by hand in the Hub (/queue) and exported to Anki; never mark anything carded or known from here unless I say so.",
      inputSchema: {
        words: z.array(vocabGapSchema).min(1),
        taken_at: z.string().optional().describe("ISO date the words came up; default now, or the session's date when session_id is given"),
        label: z.string().optional().describe("Where: 'Satori Reader: ...', 'SKM N4 L6 explanation', 'chat'; defaults to the session's label when session_id is given"),
        session_id: z.string().uuid().optional().describe("Logged session the words belong to; pass with number"),
        number: z.number().int().positive().optional().describe("Printed number of the question in that session"),
        part: partSchema.optional().describe("Part (blank) of that question, for a multi-blank question"),
        position: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based order in the session, only when number (+ part) still matches several attempts"),
      },
    },
    async (args) => {
      try {
        const at = args.taken_at ? new Date(args.taken_at) : new Date();
        if (Number.isNaN(at.getTime())) throw new Error(`Invalid taken_at: ${args.taken_at}`);
        const words = toVocabGaps(args.words) ?? [];
        if (args.session_id !== undefined || args.number !== undefined || args.part !== undefined || args.position !== undefined) {
          if (args.session_id === undefined || args.number === undefined) {
            throw new Error(
              "To tie words to a logged question, pass both session_id and number (part for one blank of a multi-blank question, position only when that still repeats).",
            );
          }
          return ok(
            await queueVocabForAttempt({
              sessionId: args.session_id,
              number: args.number,
              part: args.part,
              position: args.position,
              words,
              at: args.taken_at ? at : undefined,
              label: args.label ?? null,
            }),
          );
        }
        return ok(await queueVocab(words, { at, surface: "claude-ai", label: args.label ?? null }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_vocab_queue",
    {
      title: "Read the vocab queue",
      description:
        "Words on the vocab queue with their status (queued = waiting for a card decision, carded, skipped, known), reading, meaning, asMet (the form as printed, e.g. おおぜい for 大勢, when a sighting recorded one; null otherwise), how often each has stalled and the latest context. Default: the queued ones, newest first. Use it when I ask what is on the queue or whether a word is already there.",
      inputSchema: {
        status: z.enum([...VOCAB_QUEUE_STATUSES, "all"]).optional().describe("Default queued"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const [rows, counts] = await Promise.all([
          listVocabQueue({ status: args.status ?? "queued", limit: args.limit ?? 50 }),
          countVocabQueue(),
        ]);
        return ok({
          counts,
          words: rows.map((r) => {
            const latest = r.sightings[r.sightings.length - 1];
            return {
              id: r.id,
              text: r.text,
              asMet: effectiveAsMet(r.sightings),
              reading: r.reading,
              meaning: r.meaning,
              status: r.status,
              seenCount: r.seenCount,
              lastSeenAt: r.lastSeenAt.toISOString().slice(0, 10),
              itemId: r.itemId,
              lastContext: latest?.context ?? null,
              lastLabel: latest?.label ?? null,
            };
          }),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_vocab_queue",
    {
      title: "Set vocab queue status",
      description:
        "Move queue rows to carded (a card exists), known (already in my decks or genuinely known), skipped (not worth a card) or back to queued. Only when I say so; the Hub's /queue page is the usual place for this. Result: {updated}.",
      inputSchema: {
        ids: z.array(z.string().uuid()).min(1).describe("Row ids from get_vocab_queue"),
        status: z.enum(VOCAB_QUEUE_STATUSES),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        return ok({ updated: await setVocabQueueStatus(args.ids, args.status) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- Hindsight memory (docs/plans/07-hindsight.md, Phase B). Read-only; the bank is a
  // mirror of this ledger, refreshed by `npm run hindsight:mirror` on the home machine, so
  // it can lag the ledger by a session or two. Both tools degrade to a status instead of
  // failing when the add-on is unconfigured or the tunnel is down.
  server.registerTool(
    "memory_recall",
    {
      title: "Recall from the memory graph",
      description:
        "Search the Hindsight memory bank built from this ledger's insights and sessions. Each hit is an extracted fact " +
        "(type world), a consolidated cross-session pattern (observation) or an experience, with the date it is about and a " +
        "documentId (insight:<id> / session:<id>) pointing back at the ledger row. Use it next to get_insights when the question " +
        "is about patterns over time (\"what keeps going wrong with comparisons?\") rather than a single item. " +
        "Result: {status:'ok', hits:[{text,type,when,documentId,entities}], count} or {status:'offline'|'unconfigured'|'rejected', ...}; " +
        "on anything but ok, say the memory graph is unavailable and continue with the ledger tools. The bank lags the ledger " +
        "until the next mirror run, so the newest session may be missing.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language or Japanese query, e.g. 'ほど misses' or 'what did I confuse with より'"),
        budget: z.enum(["low", "mid", "high"]).optional().describe("Retrieval effort; default mid"),
        limit: z.number().int().min(1).max(25).optional().describe("Max hits; default 10"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => ok(await memoryRecall(args.query, { budget: args.budget, limit: args.limit })),
  );

  server.registerTool(
    "memory_reflect",
    {
      title: "Ask the memory graph",
      description:
        "Have Hindsight answer a question from the memory bank with a grounded, synthesised reply (it runs a small agent over " +
        "the graph; 30-60 s, so call it once per question and only for synthesis the ledger reports cannot give: 'what " +
        "patterns show up across my grammar misses and what should I drill?'). Result: {status:'ok', text, basedOn:<memories used>} " +
        "or a non-ok status as in memory_recall; a timeout is reported as offline, do not retry in the same turn.",
      inputSchema: {
        question: z.string().min(1),
        budget: z.enum(["low", "mid"]).optional().describe("Reasoning effort; default low (mid often exceeds the time limit)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => ok(await memoryReflect(args.question, { budget: args.budget })),
  );

  return server;
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
