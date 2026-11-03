// Imports the claude.ai project's jlpt_500_ledger.csv (the pre-MCP study ledger) into the
// practice tables as confirmed sessions, one per date, so the ~150 already-reviewed
// questions count as evidence and show up in the root-cause report.
//
// Expected columns (header row, any order; extra columns ignored):
//   date, week_day, q_num, section, grammar_point, level, genki_ref, genki_coverage, result, note
// Optional: root_cause (one of lib/types.ts ROOT_CAUSES). Without it, a cause is inferred
// from the note only when a keyword makes it unambiguous; otherwise the miss stays
// unclassified and can be tagged later.
//
// Idempotent: deletes every previous import session (surface='import') and its
// observations, then re-inserts. Genki refs are merged into items.detail on each matched
// grammar/vocab item (edition noted in the key: genkiRef = 3rd ed.).
//
// Usage: npm run db:import-ledger [-- path/to/ledger.csv]
//        default path: data/import/jlpt_500_ledger.csv
import { neon } from "@neondatabase/serverless";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = resolve(process.argv[2] ?? join(root, "data", "import", "jlpt_500_ledger.csv"));
const SOURCE_NAME = "Shin Nihongo 500 Mon N4-N5";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
if (!existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}\nDownload jlpt_500_ledger.csv from the claude.ai project files into data/import/ (gitignored).`);
  process.exit(1);
}
const sql = neon(url);

// --- Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const raw = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
const [headerRow, ...dataRows] = parseCsv(raw);
const header = headerRow.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
const col = (name) => header.indexOf(name);
for (const required of ["date", "section", "result"]) {
  if (col(required) < 0) {
    console.error(`CSV is missing the '${required}' column. Header: ${header.join(", ")}`);
    process.exit(1);
  }
}
const get = (row, name) => {
  const i = col(name);
  return i < 0 ? "" : (row[i] ?? "").trim();
};

// --- Normalizers ---
const SECTION_ALIASES = {
  kanji: "kanji", moji: "kanji", 文字: "kanji",
  vocab: "vocab", vocabulary: "vocab", goi: "vocab", 語彙: "vocab",
  grammar: "grammar", bunpou: "grammar", bunpo: "grammar", bunpoo: "grammar", 文法: "grammar",
  reading: "reading", dokkai: "reading", 読解: "reading",
  listening: "listening", choukai: "listening", chokai: "listening", 聴解: "listening",
  other: "other",
};
const normalizeSection = (s) => SECTION_ALIASES[s.toLowerCase()] ?? SECTION_ALIASES[s] ?? "other";

function parseResult(s) {
  const v = s.toLowerCase();
  if (["right", "correct", "o", "○", "〇", "◯", "1", "true", "yes", "y", "✓", "ok", "pass"].includes(v)) return true;
  if (["wrong", "incorrect", "x", "×", "✗", "0", "false", "no", "n", "miss", "fail"].includes(v)) return false;
  return null;
}

const ROOT_CAUSES = new Set([
  "grammar-unknown", "vocab-in-grammar", "reading-selection", "particle-cue-missed",
  "pattern-glue", "misparse", "careless", "time-pressure",
]);

// Conservative keyword inference from the note; first match wins, ambiguity stays null.
const CAUSE_RULES = [
  [/\bcareless|slip|misread the (?:question|answer)|knew (?:it|this)\b/i, "careless"],
  [/\btime[- ]pressure|rushed|ran out of time|under time\b/i, "time-pressure"],
  [/\bparticle|intransitive|transitive|が→|で→|に→\b/i, "particle-cue-missed"],
  [/\bkun|on'?yomi|reading|おんよみ|くんよみ|読み\b/i, "reading-selection"],
  [/\bvocab(?:ulary)? (?:gap|unknown|in grammar)|didn'?t know the word|unknown word\b/i, "vocab-in-grammar"],
  [/\battach|glue|のほう|なほう|conjugat/i, "pattern-glue"],
  [/\bmispars|parse|relative clause|misread the sentence\b/i, "misparse"],
  [/\bnever (?:learned|seen)|unknown grammar|not (?:yet )?(?:learned|covered)|grammar gap\b/i, "grammar-unknown"],
];
function inferCause(note, explicit) {
  if (explicit && ROOT_CAUSES.has(explicit)) return explicit;
  if (explicit) console.warn(`  ! unknown root_cause '${explicit}' ignored`);
  if (!note) return null;
  for (const [re, cause] of CAUSE_RULES) if (re.test(note)) return cause;
  return null;
}

const normalizePattern = (s) =>
  s
    .replace(/[（(][^（()）]*[)）]\s*$/u, "")
    .replace(/^[\s〜～~]+/u, "")
    .replace(/[\s〜～~]+$/u, "");

// --- Item resolution (grammar first, then vocab for NOT-IN-GENKI words) ---
const itemRows = await sql.query(`SELECT id, kind, headword, reading FROM items WHERE kind IN ('grammar','vocab')`);
const group = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(r.id);
    else m.set(k, [r.id]);
  }
  return m;
};
const uniq = (ids) => (ids && ids.length === 1 ? ids[0] : null);
const grammarRows = itemRows.filter((r) => r.kind === "grammar");
const vocabRows = itemRows.filter((r) => r.kind === "vocab");
const grammarExact = group(grammarRows, (r) => r.headword);
const grammarNorm = group(grammarRows, (r) => normalizePattern(r.headword));
const vocabExact = group(vocabRows, (r) => r.headword);
const vocabReading = group(vocabRows, (r) => r.reading);
const KANA_ONLY = /^[぀-ゟ゠-ヿ]+$/u;

function resolveItem(text) {
  const t = text.trim();
  if (!t) return null;
  const g = uniq(grammarExact.get(t)) ?? uniq(grammarNorm.get(normalizePattern(t)));
  if (g) return { kind: "grammar", itemId: g };
  const v = uniq(vocabExact.get(t)) ?? (KANA_ONLY.test(t) ? uniq(vocabReading.get(t)) : null);
  if (v) return { kind: "vocab", itemId: v };
  return null;
}

// --- Group rows into sessions by date ---
const sessions = new Map();
let skipped = 0;
for (const row of dataRows) {
  const date = get(row, "date");
  const takenAt = new Date(date);
  if (!date || Number.isNaN(takenAt.getTime())) {
    skipped++;
    continue;
  }
  const key = takenAt.toISOString().slice(0, 10);
  let s = sessions.get(key);
  if (!s) {
    const weekDay = get(row, "week_day");
    s = { key, takenAt, label: weekDay ? `500問 ${weekDay} (${key})` : `500問 ${key}`, rows: [] };
    sessions.set(key, s);
  }
  s.rows.push(row);
}
console.log(`Parsed ${dataRows.length} rows into ${sessions.size} sessions (${skipped} rows without a usable date).`);

// --- Wipe previous import, then insert ---
const prior = await sql.query(`SELECT id FROM practice_sessions WHERE surface = 'import'`);
if (prior.length > 0) {
  const ids = prior.map((p) => p.id);
  await sql.query(
    `DELETE FROM observations WHERE source = 'practice' AND meta->>'sessionId' = ANY($1::text[])`,
    [ids],
  );
  await sql.query(`DELETE FROM practice_sessions WHERE id = ANY($1::uuid[])`, [ids]);
  console.log(`Removed ${ids.length} previous import session(s).`);
}

const unresolved = new Map(); // text -> count
const genkiUpdates = new Map(); // itemId -> {ref, coverage}
let questions = 0;
let observations = 0;
let classified = 0;
let misses = 0;

for (const s of [...sessions.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const [session] = await sql.query(
    `INSERT INTO practice_sessions (label, source_name, status, surface, image_paths, taken_at)
     VALUES ($1, $2, 'confirmed', 'import', '[]'::jsonb, $3) RETURNING id`,
    [s.label, SOURCE_NAME, s.takenAt.toISOString()],
  );
  let position = 0;
  for (const row of s.rows) {
    position++;
    const qNum = Number.parseInt(get(row, "q_num"), 10);
    const number = Number.isFinite(qNum) ? qNum : position;
    const section = normalizeSection(get(row, "section"));
    const levelRaw = get(row, "level").toUpperCase();
    const level = levelRaw === "N5" || levelRaw === "N4" ? levelRaw : null;
    const correct = parseResult(get(row, "result"));
    const note = get(row, "note") || null;
    const grammarPoint = get(row, "grammar_point");
    const rootCause = correct === false ? inferCause(note, get(row, "root_cause")) : null;
    if (correct === false) {
      misses++;
      if (rootCause) classified++;
    }

    const match = resolveItem(grammarPoint);
    const tags = grammarPoint ? [{ kind: match?.kind ?? "grammar", text: grammarPoint, itemId: match?.itemId ?? null }] : [];
    if (grammarPoint && !match) unresolved.set(grammarPoint, (unresolved.get(grammarPoint) ?? 0) + 1);

    const [q] = await sql.query(
      `INSERT INTO practice_questions
         (session_id, number, section, stem, choices, correct_choice, user_choice, is_correct, explanation, tags, level, root_cause, note)
       VALUES ($1, $2, $3, '', '[]'::jsonb, NULL, NULL, $4, NULL, $5::jsonb, $6, $7, $8) RETURNING id`,
      [session.id, number, section, correct, JSON.stringify(tags), level, rootCause, note],
    );
    questions++;

    if (match) {
      await sql.query(
        `INSERT INTO question_items (question_id, item_id, role) VALUES ($1, $2, 'tested') ON CONFLICT DO NOTHING`,
        [q.id, match.itemId],
      );
      if (correct !== null) {
        await sql.query(
          `INSERT INTO observations (item_id, source, kind, correct, occurred_at, meta)
           VALUES ($1, 'practice', 'answer', $2, $3, $4::jsonb)`,
          [match.itemId, correct, s.takenAt.toISOString(), JSON.stringify({ sessionId: session.id, questionId: q.id, surface: "import" })],
        );
        observations++;
      }
      const ref = get(row, "genki_ref");
      const coverage = get(row, "genki_coverage");
      if (ref || coverage) {
        const prev = genkiUpdates.get(match.itemId) ?? {};
        genkiUpdates.set(match.itemId, { ref: ref || prev.ref, coverage: coverage || prev.coverage });
      }
    }
  }
}

for (const [itemId, { ref, coverage }] of genkiUpdates) {
  await sql.query(
    `UPDATE items SET detail = coalesce(detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('genkiRef', $2::text, 'genkiCoverage', $3::text)) WHERE id = $1`,
    [itemId, ref ?? null, coverage ?? null],
  );
}

console.log(`Inserted ${sessions.size} sessions, ${questions} questions, ${observations} observations.`);
console.log(`Misses: ${misses}, root cause set on ${classified} (${misses - classified} left unclassified).`);
console.log(`Genki refs written to ${genkiUpdates.size} items.`);
if (unresolved.size > 0) {
  console.log(`\n${unresolved.size} grammar_point value(s) matched no library item (no evidence written):`);
  for (const [text, n] of [...unresolved.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${text}`);
}
