import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { bpSnapshot, wkSnapshot } from "@/lib/db/schema";
import {
  getInsights,
  getInsightTagCounts,
  listSessions,
  logAttempts,
  logInsight,
  normalizeSection,
  relinkUnresolved,
  updateSession,
  type AttemptInput,
} from "@/lib/ledger";
import { memoryRecall, memoryReflect, readHindsightConfig } from "@/lib/hindsight";
import { getReadiness } from "@/lib/readiness";
import { findItems } from "@/lib/resolve-items";
import { listStudySources, logStudy } from "@/lib/study-sources-db";
import { getAccuracyBySection, getMissesByRootCause, getPracticeWindow, getWeakItems } from "@/lib/weakness";
import { normalizeRootCause, ROOT_CAUSES, SESSION_MODES, STUDY_ACTIVITIES } from "@/lib/types";

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

const SERVER_INFO = { name: "jlpt-hub-study-ledger", version: "1.4.0" };

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

const attemptSchema = z.object({
  number: z.number().int().positive().optional().describe("Printed question number; defaults to position"),
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
  stem: z.string().optional().describe("Question text if worth keeping"),
  choices: z.array(z.string()).optional(),
  explanation: z.string().optional(),
  tags: z.array(tagSchema).default([]).describe("1-3 items the question really tests; these become evidence"),
  meta: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Any other structured facts about this attempt with no field of their own; stored as-is"),
});

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "log_attempts",
    {
      title: "Log practice attempts",
      description:
        "Record one reviewed page/set of questions as a confirmed session. mode=practice (default) is closed-book work: answers count toward accuracy, the weak list and root-cause reports. mode=lesson is open-book work done right after reading the explanation (textbook example sentences, れんしゅう with the notes in view): it is recorded as exposure, moves items from unseen to learning, and is excluded from every accuracy figure. Each attempt carries right/wrong, the item(s) it tests, a free-text note, and for misses a root_cause (preferred list given on the field; any label accepted). Nothing is rejected for not fitting a category: unknown sections land in 'other' with the raw word kept, and 'meta' takes anything else. Name the book or app in 'source' (a catalog slug from list_sources, or its name/alias) and put the lesson/page in 'source_name'; when 'source' is absent, source_name is matched against the catalog too. Result: sessionId, mode, questions, graded (attempts with correct true/false), correct, observations (evidence rows written: one per resolved tag per graded attempt in practice, one per resolved tag per attempt in lesson; tags that matched nothing write none until relink_tags), unresolvedTags (tags that matched no library item, each with the closest items and a match label; 'prefix-only' means a shorter, different item, not the one meant), source (the catalog entry linked, or null) and sourceUnresolved (the source text when it matched no catalog entry; the text is still kept on the session). The tag text is kept, so relink_tags can attach it later once the item or alias exists. A session logged with the wrong mode, label, date or source is fixed with update_session, not re-logged. For study time that produced no graded answers (reading, app reviews, listening), use log_study instead.",
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

        const attempts: AttemptInput[] = args.attempts.map((a) => {
          // Never reject for an unrecognised category: fall back and keep the raw word.
          const section = normalizeSection(a.section) ?? "other";
          const meta: Record<string, unknown> = { ...(a.meta ?? {}) };
          if (section === "other" && normalizeSection(a.section) === null) meta.sectionRaw = a.section;
          return {
            number: a.number,
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
        items: z.array(tagSchema).optional().describe("Library items the note is about, if any"),
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
        "Newest-first notes, optionally filtered by topic: matches the text, an exact tag, or a linked library item (headword, alias, reading or pattern, e.g. 'ほど'). Also returns every tag in use with counts, so tag vocabulary can be reused.",
      inputSchema: {
        topic: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const [list, tags] = await Promise.all([getInsights(args), getInsightTagCounts()]);
        return ok({ insights: list, tags });
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
        "Look up library items by headword, alias, kana reading, grammar pattern or English meaning, ranked by closeness. Use it before tagging when unsure of the canonical form, and to check whether an item exists at all. Each hit carries match: exact, extends (the item is a longer form of the query), contains, meaning, or prefix-only (the item is merely a prefix of the query, e.g. まで for 〜までに: a different, shorter item, so an unresolved tag is still unresolved).",
      inputSchema: {
        query: z.string().min(1).describe("e.g. 'ほど', 'いちばん', 'black tea', '〜と〜とどちら'"),
        kind: z.enum(["vocab", "kanji", "grammar"]).optional().describe("Prefer this kind in the ranking"),
        limit: z.number().int().min(1).max(25).default(8),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return ok({ query: args.query, items: await findItems(args.query, { kind: args.kind ?? null, limit: args.limit }) });
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
        "Re-run item resolution over every stored attempt tag and insight item that matched nothing when logged, and attach the missing evidence. Idempotent and safe to run any time; run it after an item or alias is added to the library. Returns what was linked and what still matches nothing, with suggestions.",
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
