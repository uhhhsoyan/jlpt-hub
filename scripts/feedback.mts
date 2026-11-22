// The feedback inbox from a terminal, for Claude Code sessions that pick up the handoffs the
// claude.ai chat files with send_feedback (same code path as the get_feedback /
// update_feedback MCP tools, lib/feedback.ts).
//
// Usage (node --env-file=.env.local --import tsx scripts/feedback.mts):
//   npm run feedback -- list [--status open|in_progress|done|dismissed|all] [--limit N]
//   npm run feedback -- show <id>                  prints the markdown body raw
//   npm run feedback -- start <id>                 marks it in_progress
//   npm run feedback -- done <id> --resolution "PR #45, #46"
//   npm run feedback -- dismiss <id> --resolution "duplicate of …"
import {
  countFeedback,
  FEEDBACK_STATUSES,
  getFeedbackById,
  listFeedback,
  previewFeedback,
  updateFeedback,
  type FeedbackFilter,
} from "../lib/feedback";
import type { FeedbackStatus } from "../lib/types";

const USAGE = `Usage:
  npm run feedback -- list [--status open|in_progress|done|dismissed|all] [--limit N]
  npm run feedback -- show <id>
  npm run feedback -- start <id>
  npm run feedback -- done <id> --resolution "…"
  npm run feedback -- dismiss <id> --resolution "…"`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value.\n${USAGE}`);
  return v;
}

function positional(args: string[], what: string): string {
  const v = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
  if (!v) throw new Error(`Missing ${what}.\n${USAGE}`);
  return v;
}

function parseStatus(raw: string | undefined): FeedbackFilter {
  if (raw === undefined) return "open";
  if (raw === "all" || (FEEDBACK_STATUSES as readonly string[]).includes(raw)) return raw as FeedbackFilter;
  throw new Error(`--status must be one of ${FEEDBACK_STATUSES.join(", ")}, all; got "${raw}".`);
}

async function list(args: string[]): Promise<void> {
  const status = parseStatus(flag(args, "status"));
  const limitRaw = flag(args, "limit");
  const limit = limitRaw === undefined ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got "${limitRaw}".`);
  const [rows, counts] = await Promise.all([listFeedback({ status, limit }), countFeedback()]);
  console.log(FEEDBACK_STATUSES.map((s) => `${s} ${counts[s]}`).join(" · "));
  if (rows.length === 0) {
    console.log(`No ${status === "all" ? "" : `${status} `}feedback.`);
    return;
  }
  for (const r of rows) {
    const period = r.periodFrom ? (r.periodFrom === r.periodTo ? r.periodFrom : `${r.periodFrom}..${r.periodTo}`) : "no period";
    const { chars, preview } = previewFeedback(r.body, 160);
    console.log(`\n${r.id}  [${r.status}]  filed ${r.createdAt.toISOString().slice(0, 10)}  ${period}  ${chars} chars  v${r.serverVersion}`);
    console.log(`  ${r.title}`);
    console.log(`  ${preview.replace(/\s+/g, " ")}`);
    if (r.resolution) console.log(`  resolution: ${r.resolution}`);
  }
}

async function show(args: string[]): Promise<void> {
  const row = await getFeedbackById(positional(args, "id"));
  process.stdout.write(row.body.endsWith("\n") ? row.body : `${row.body}\n`);
}

async function setStatus(args: string[], status: FeedbackStatus): Promise<void> {
  const id = positional(args, "id");
  const result = await updateFeedback(id, { status, resolution: flag(args, "resolution") });
  console.log(JSON.stringify(result, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "list":
      await list(rest);
      break;
    case "show":
      await show(rest);
      break;
    case "start":
      await setStatus(rest, "in_progress");
      break;
    case "done":
      await setStatus(rest, "done");
      break;
    case "dismiss":
      await setStatus(rest, "dismissed");
      break;
    default:
      console.error(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
