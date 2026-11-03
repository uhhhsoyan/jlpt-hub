import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { bpSnapshot, wkSnapshot } from "@/lib/db/schema";
import {
  getInsights,
  listSessions,
  logAttempts,
  logInsight,
  normalizeSection,
  type AttemptInput,
} from "@/lib/ledger";
import { getReadiness } from "@/lib/readiness";
import { getAccuracyBySection, getMissesByRootCause, getWeakItems } from "@/lib/weakness";
import { normalizeRootCause, ROOT_CAUSES } from "@/lib/types";

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

const SERVER_INFO = { name: "jlpt-hub-study-ledger", version: "1.0.0" };

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
    .describe("Canonical form: dictionary form of a verb, a single bare kanji, or a grammar pattern like 〜ておく"),
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
        "Record one reviewed page/set of practice questions as a confirmed session. Each attempt carries right/wrong, the item(s) it tests, a free-text note, and for misses a root_cause (preferred list given on the field; any label accepted). Nothing is rejected for not fitting a category: unknown sections land in 'other' with the raw word kept, and 'meta' takes anything else. Returns the session id and any tags that matched no library item (no evidence is written for those; fix the tag text and re-log just those if it matters).",
      inputSchema: {
        label: z.string().describe("e.g. '500問 Week 3 Day 2' or 'Mock test 1 文法'"),
        source_name: z.string().optional().describe("e.g. 'Shin Nihongo 500 Mon N4-N5'"),
        taken_at: z.string().describe("ISO date or datetime the page was done, e.g. 2026-10-27"),
        surface: z.enum(["claude-ai", "claude-code", "hub"]).default("claude-ai"),
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
          sourceName: args.source_name ?? null,
          takenAt,
          surface: args.surface,
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
        "Save a narrative note about a recurring pattern or belief, e.g. 'confuses どっち/どう under time pressure'. Tag it so it can be recalled by topic later.",
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
      description: "Newest-first notes, optionally filtered by a topic word (matches text or an exact tag).",
      inputSchema: {
        topic: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return ok(await getInsights(args));
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
        "What is going wrong. by=root_cause: misses grouped by cause over the window. by=section: accuracy per exam section over the window. by=item: the weakest library items by recency-decayed accuracy (window ignored; 30-day half-life).",
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
        if (args.by === "section") {
          return ok({ by: "section", windowDays: args.window_days, sections: await getAccuracyBySection(args.window_days) });
        }
        return ok({
          by: "root_cause",
          windowDays: args.window_days,
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
        "Days to the exam, inventory coverage per kind and level (unseen/learning/solid/mastered), and the last 30 days of practice accuracy by section and misses by root cause.",
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
    "list_sessions",
    {
      title: "Recent sessions",
      description: "The most recently logged practice sessions with their scores, to check what is already in the ledger.",
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
