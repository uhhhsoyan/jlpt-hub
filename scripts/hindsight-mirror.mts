// Mirror the study ledger (Postgres, ground truth) into a local Hindsight memory bank.
// Read-only against Neon; writes only to Hindsight. Idempotent via .hindsight/mirror-state.json.
//
// Usage: npm run hindsight:mirror              # retain rows not yet mirrored
//        npm run hindsight:mirror -- --reset   # delete the bank + state, then mirror everything
//        npm run hindsight:mirror -- --dry-run # print the memories that would be retained
//
// Env (optional): HINDSIGHT_URL (default http://localhost:8888), HINDSIGHT_BANK (jlpt-study),
// HINDSIGHT_API_KEY (bearer token when the container runs with auth; see scripts/hindsight.sh).
// See docs/plans/07-hindsight.md.
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { getDb } from "../lib/db";
import { insights, items, practiceSessions, practiceQuestions } from "../lib/db/schema";
import type { ItemRow, PracticeQuestionRow, PracticeSessionRow } from "../lib/db/schema";
import type { QuestionTag } from "../lib/types";

const BASE_URL = process.env.HINDSIGHT_URL ?? "http://localhost:8888";
const BANK = process.env.HINDSIGHT_BANK ?? "jlpt-study";
const STATE_DIR = ".hindsight";
const STATE_FILE = `${STATE_DIR}/mirror-state.json`;

const args = new Set(process.argv.slice(2));
const reset = args.has("--reset");
const dryRun = args.has("--dry-run");

// Who the memories are about. Goes into the bank's retain/reflect missions so extraction
// and answers are framed around this learner rather than a generic assistant.
const BACKGROUND = [
  "These memories are about one adult learner preparing for the JLPT N4 exam on 2026-12-06.",
  "Study materials: 新完全マスター (SKM) N4 文法, Genki I/II, 新にほんご500問 N4-N5, WaniKani, Bunpro.",
  "Memories are: study insights (rules the learner worked out or was corrected on), graded practice",
  "sessions where each miss carries a root cause, and open-book lesson exposures.",
  "Closed-book 'practice' sessions measure ability; open-book 'lesson' sessions are exposure only.",
  "Grammar points (ほど, より, までに, のほう, つもり, はず ...), particles, vocabulary, kanji and",
  "root causes (distractor-bias, context-cue-missed, kanji-lookalike, ...) are the important entities.",
].join(" ");

const RETAIN_MISSION =
  BACKGROUND +
  " When extracting, keep the Japanese grammar point or word verbatim as the entity, keep the root" +
  " cause label verbatim, and record the date so misses can be compared over time.";

const REFLECT_MISSION =
  BACKGROUND +
  " Answer as a study coach: cite the concrete misses and insights, group recurring patterns by" +
  " grammar point and root cause, and prefer specific drills over generic advice.";

interface MirrorState {
  bank: string;
  insights: string[];
  sessions: string[];
}

function loadState(): MirrorState {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as MirrorState;
    if (s.bank === BANK) return s;
  }
  return { bank: BANK, insights: [], sessions: [] };
}

function saveState(state: MirrorState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "〜ほど〜ない (grammar: not as ... as)" — the tag text plus what the library knows about it. */
function describeTag(tag: QuestionTag, byId: Map<string, ItemRow>): string {
  const item = tag.itemId ? byId.get(tag.itemId) : undefined;
  if (!item) return `${tag.text} (${tag.kind}, unlinked)`;
  const reading = item.reading && item.reading !== item.headword ? ` ${item.reading}` : "";
  const head = item.headword === tag.text ? item.headword : `${tag.text} = ${item.headword}`;
  return `${head}${reading} (${item.kind}: ${item.meaning})`;
}

function describeItem(item: ItemRow): string {
  const reading = item.reading && item.reading !== item.headword ? ` ${item.reading}` : "";
  return `${item.headword}${reading} (${item.kind}: ${item.meaning})`;
}

function insightMemory(row: typeof insights.$inferSelect, byId: Map<string, ItemRow>): string {
  const linked = row.itemIds.map((id) => byId.get(id)).filter((i): i is ItemRow => !!i);
  const unlinked = row.items.filter((t) => !t.itemId).map((t) => `${t.text} (${t.kind})`);
  const about = [...linked.map(describeItem), ...unlinked];
  const lines = [
    `Study insight logged ${ymd(row.createdAt)} (source: ${row.source}).`,
    about.length ? `About: ${about.join("; ")}.` : "",
    row.tags.length ? `Tags: ${row.tags.join(", ")}.` : "",
    row.text,
  ];
  return lines.filter(Boolean).join("\n");
}

function sessionMemory(
  s: PracticeSessionRow,
  qs: PracticeQuestionRow[],
  byId: Map<string, ItemRow>,
): string {
  const modeText =
    s.mode === "lesson"
      ? "open-book lesson (exposure only; does not count toward accuracy)"
      : "closed-book practice (counts toward accuracy)";
  const missed = qs.filter((q) => q.isCorrect === false);
  const right = qs.filter((q) => q.isCorrect === true);
  const ungraded = qs.filter((q) => q.isCorrect === null);
  const tags = (q: PracticeQuestionRow) =>
    q.tags.length ? q.tags.map((t) => describeTag(t, byId)).join(", ") : "no tagged item";

  const lines: string[] = [
    `Study session "${s.label}" on ${ymd(s.takenAt)}: ${modeText}` +
      (s.sourceName ? `, source: ${s.sourceName}` : "") +
      (s.timed === true ? ", under exam timing" : "") +
      `. ${qs.length} questions: ${right.length} correct, ${missed.length} missed` +
      (ungraded.length ? `, ${ungraded.length} ungraded` : "") +
      ".",
  ];
  for (const q of missed) {
    let line = `Missed Q${q.number} (${q.section}) on ${tags(q)}`;
    line += `; root cause ${q.rootCause ?? "unclassified"}`;
    if (q.note) line += `; note: ${q.note}`;
    if (q.stem) line += `; stem: ${q.stem}`;
    if (q.choices.length && q.userChoice !== null && q.correctChoice !== null) {
      line += ` (picked "${q.choices[q.userChoice]}", answer "${q.choices[q.correctChoice]}")`;
    }
    lines.push(line + ".");
  }
  if (right.length) {
    lines.push(`Got right: ${right.map((q) => `Q${q.number} ${tags(q)}`).join("; ")}.`);
    const noted = right.filter((q) => q.note);
    if (noted.length) {
      lines.push(
        `Notes on correct answers: ${noted.map((q) => `Q${q.number}: ${q.note}`).join(" | ")}.`,
      );
    }
  }
  if (ungraded.length) {
    lines.push(`Ungraded: ${ungraded.map((q) => `Q${q.number} ${tags(q)}`).join("; ")}.`);
  }
  return lines.join("\n");
}

// ---- main ---------------------------------------------------------------------------

const client = new HindsightClient({ baseUrl: BASE_URL, apiKey: process.env.HINDSIGHT_API_KEY });
const db = getDb();

if (!dryRun) {
  // Fail fast if Hindsight is down; the ledger never depends on it, only this script does.
  try {
    await client.getVersion();
  } catch (e) {
    console.error(`Hindsight not reachable at ${BASE_URL} (bash scripts/hindsight.sh up): ${e}`);
    process.exit(1);
  }
}

let state = loadState();

if (reset && !dryRun) {
  try {
    await client.deleteBank(BANK);
    console.log(`bank ${BANK}: deleted`);
  } catch (e) {
    console.log(`bank ${BANK}: nothing to delete (${(e as Error).message.slice(0, 80)})`);
  }
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  state = { bank: BANK, insights: [], sessions: [] };
}

if (!dryRun) {
  // PUT is create-or-update, so this also refreshes the missions on every run.
  await client.createBank(BANK, { retainMission: RETAIN_MISSION, reflectMission: REFLECT_MISSION });
}

// Read-only loads.
const allInsights = await db.select().from(insights).orderBy(insights.createdAt);
const allSessions = (await db.select().from(practiceSessions).orderBy(practiceSessions.takenAt)).filter(
  (s) => s.status === "confirmed",
);
const allQuestions = allSessions.length
  ? await db
      .select()
      .from(practiceQuestions)
      .where(inArray(practiceQuestions.sessionId, allSessions.map((s) => s.id)))
  : [];

const itemIds = new Set<string>();
for (const i of allInsights) i.itemIds.forEach((id) => itemIds.add(id));
for (const q of allQuestions) q.tags.forEach((t) => t.itemId && itemIds.add(t.itemId));
const itemRows = itemIds.size ? await db.select().from(items).where(inArray(items.id, [...itemIds])) : [];
const byId = new Map(itemRows.map((i) => [i.id, i]));

const questionsBySession = new Map<string, PracticeQuestionRow[]>();
for (const q of allQuestions) {
  const list = questionsBySession.get(q.sessionId) ?? [];
  list.push(q);
  questionsBySession.set(q.sessionId, list);
}

const done = { insights: 0, sessions: 0, skipped: 0, failed: 0 };
const mirroredInsights = new Set(state.insights);
const mirroredSessions = new Set(state.sessions);

async function retain(
  kind: "insight" | "session",
  id: string,
  content: string,
  timestamp: Date,
  metadata: Record<string, string>,
) {
  if (dryRun) {
    console.log(`--- ${kind} ${id} @ ${timestamp.toISOString()}\n${content}\n`);
    return true;
  }
  try {
    await client.retain(BANK, content, {
      timestamp,
      context: kind === "insight" ? "study insight" : "study session",
      metadata,
      documentId: `${kind}:${id}`,
      async: false,
    });
    return true;
  } catch (e) {
    done.failed++;
    console.error(`retain ${kind} ${id} failed: ${(e as Error).message.slice(0, 300)}`);
    return false;
  }
}

for (const row of allInsights) {
  if (mirroredInsights.has(row.id)) {
    done.skipped++;
    continue;
  }
  const ok = await retain("insight", row.id, insightMemory(row, byId), row.createdAt, {
    source: "insight",
    id: row.id,
  });
  if (ok && !dryRun) {
    state.insights.push(row.id);
    saveState(state);
    done.insights++;
    console.log(`insight ${row.id} (${ymd(row.createdAt)})`);
  } else if (ok) done.insights++;
}

for (const s of allSessions) {
  if (mirroredSessions.has(s.id)) {
    done.skipped++;
    continue;
  }
  const qs = (questionsBySession.get(s.id) ?? []).sort((a, b) => a.number - b.number);
  const ok = await retain("session", s.id, sessionMemory(s, qs, byId), s.takenAt, {
    source: "session",
    id: s.id,
    mode: s.mode,
  });
  if (ok && !dryRun) {
    state.sessions.push(s.id);
    saveState(state);
    done.sessions++;
    console.log(`session ${s.id} "${s.label}" (${qs.length} questions)`);
  } else if (ok) done.sessions++;
}

console.log(
  `${dryRun ? "[dry-run] " : ""}insights mirrored: ${done.insights}, sessions mirrored: ${done.sessions}, ` +
    `skipped (already mirrored): ${done.skipped}, failed: ${done.failed}` +
    (dryRun ? "" : ` — bank ${BANK} at ${BASE_URL}`),
);
