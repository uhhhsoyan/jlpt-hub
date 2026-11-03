// Imports the claude.ai project's jlpt_500_ledger.csv (the pre-MCP study ledger) into the
// practice tables as confirmed sessions, one per date, so the already-reviewed questions
// count as evidence and show up in the root-cause report.
//
// Expected columns (header row, any order; extra columns ignored):
//   date, week_day, q_num, section, grammar_point, level, genki_ref, genki_coverage, result, note
// Optional: root_cause (prefer one of lib/types.ts ROOT_CAUSES; any other label is kept
// verbatim, kebab-cased, and reported under its own name). Without it, a cause is inferred
// from the note only when a keyword makes it unambiguous; otherwise the miss stays
// unclassified and can be tagged later.
//
// Item linking: grammar_point is a free-text label ("あまり + negative", "kanji-reading:大人(おとな)",
// "借りた vs 貸した"). A label that exactly matches a library headword resolves directly;
// everything else is mapped to library items by Claude (full N5/N4 inventory in the prompt,
// 1–3 items per label). Answers are cached in data/import/ledger-tags.json so re-runs are
// free and deterministic; delete an entry (or the file) to re-map. --no-claude skips the
// mapping step and uses the cache only.
//
// Idempotent: deletes every previous import session (surface='import') and its
// observations, then re-inserts. Genki refs are merged into items.detail on each matched
// grammar item (edition noted in the key: genkiRef = 3rd ed.).
//
// Usage: npm run db:import-ledger [-- [--no-claude] path/to/ledger.csv]
//        default path: data/import/jlpt_500_ledger.csv
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const useClaude = !args.includes("--no-claude");
const csvArg = args.find((a) => !a.startsWith("--"));
const csvPath = resolve(csvArg ?? join(root, "data", "import", "jlpt_500_ledger.csv"));
const cachePath = join(dirname(csvPath), "ledger-tags.json");
const SOURCE_NAME = "Shin Nihongo 500 Mon N4-N5";
const MODEL = "claude-opus-4-8"; // same model as lib/anthropic.ts

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
const normalizeCause = (s) =>
  s.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
function inferCause(note, explicit) {
  const given = explicit ? normalizeCause(explicit) : "";
  if (given) {
    if (!ROOT_CAUSES.has(given)) console.warn(`  · custom root_cause '${given}' kept as-is`);
    return given;
  }
  if (!note) return null;
  for (const [re, cause] of CAUSE_RULES) if (re.test(note)) return cause;
  return null;
}

const normalizePattern = (s) =>
  s
    .replace(/[（(][^（()）]*[)）]\s*$/u, "")
    .replace(/^[\s〜～~]+/u, "")
    .replace(/[\s〜～~]+$/u, "");

// --- Item resolution ---
const itemRows = await sql.query(`SELECT id, kind, level, headword, reading, meaning FROM items`);
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
const byKind = (kind) => itemRows.filter((r) => r.kind === kind);
const grammarExact = group(byKind("grammar"), (r) => r.headword);
const grammarNorm = group(byKind("grammar"), (r) => normalizePattern(r.headword));
const vocabExact = group(byKind("vocab"), (r) => r.headword);
const vocabReading = group(byKind("vocab"), (r) => r.reading);
const vocabHeadwordReading = group(byKind("vocab"), (r) => `${r.headword}|${r.reading}`);
const kanjiExact = group(byKind("kanji"), (r) => r.headword);
const itemById = new Map(itemRows.map((r) => [r.id, r]));
const KANA_ONLY = /^[぀-ゟ゠-ヿ]+$/u;

/** Direct match of a raw label against grammar, then vocab. */
function resolveItem(text) {
  const t = text.trim();
  if (!t) return null;
  const g = uniq(grammarExact.get(t)) ?? uniq(grammarNorm.get(normalizePattern(t)));
  if (g) return { kind: "grammar", itemId: g };
  const v = uniq(vocabExact.get(t)) ?? (KANA_ONLY.test(t) ? uniq(vocabReading.get(t)) : null);
  if (v) return { kind: "vocab", itemId: v };
  return null;
}

/** Resolve one Claude-proposed tag {kind, headword, reading} to an item id. */
function resolveProposed(tag) {
  const hw = (tag.headword ?? "").trim();
  const rd = (tag.reading ?? "").trim();
  if (!hw) return null;
  if (tag.kind === "grammar") return uniq(grammarExact.get(hw)) ?? uniq(grammarNorm.get(normalizePattern(hw)));
  if (tag.kind === "kanji") return uniq(kanjiExact.get(hw));
  if (tag.kind === "vocab") {
    return (
      (rd ? uniq(vocabHeadwordReading.get(`${hw}|${rd}`)) : null) ??
      uniq(vocabExact.get(hw)) ??
      (KANA_ONLY.test(hw) ? uniq(vocabReading.get(hw)) : null)
    );
  }
  return null;
}

// --- Claude mapping for labels the direct matcher can't place ---
const distinctLabels = new Map(); // label -> {section, level, note}
for (const row of dataRows) {
  const label = get(row, "grammar_point");
  if (!label || resolveItem(label) || distinctLabels.has(label)) continue;
  distinctLabels.set(label, { section: get(row, "section"), level: get(row, "level"), note: get(row, "note") });
}
let cache = {};
if (existsSync(cachePath)) {
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch (e) {
    console.warn(`  ! could not read ${cachePath}: ${e.message}`);
  }
}
const toMap = [...distinctLabels.keys()].filter((l) => !Array.isArray(cache[l]));

if (toMap.length > 0 && useClaude) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (expected in .env.local); rerun with --no-claude to skip mapping.");
    process.exit(1);
  }
  console.log(`Mapping ${toMap.length} label(s) to library items with ${MODEL} (${Object.keys(cache).length} cached)…`);
  const inventory = itemRows
    .map((r) => (r.kind === "vocab" ? `vocab|${r.headword}|${r.reading}|${r.meaning}` : `${r.kind}|${r.headword}|${r.meaning}`))
    .join("\n");
  const system = [
    {
      type: "text",
      text: `You map a learner's study-ledger labels onto a fixed inventory of JLPT N5/N4 library items.

Each label describes what ONE practice question (Shin Nihongo 500 Mon, N4-N5) tested. Labels are informal: Japanese mixed with English, "A vs B" contrasts, "X + Y" compositions, and "kanji-reading:" / "kanji-hyouki:" prefixes for the 文字 section (reading = choose the reading of a kanji word; hyouki = choose the correct kanji spelling of a kana word). The section (kanji / vocab / grammar) and the learner's note are given for context.

For each label return the inventory items the question actually tests, 1 to 3 of them, most central first:
- Copy "headword" EXACTLY as it appears in the inventory (and "reading" for vocab, exactly as listed). Never invent items.
- Grammar labels → grammar items. For "A vs B" include both when both are in the inventory.
- kanji-reading / kanji-hyouki labels → the vocab item for the whole word when it exists (e.g. 大人, 時計). Add the kanji item only when the question is about one character on its own.
- Vocab labels → the vocab item; add a grammar item only when a grammar pattern is the real point.
- If nothing in the inventory fits, return an empty items array for that label. Prefer an empty array over a loose match.

Return every label you were given, in the same order, with its number "n" and the label string copied verbatim.`,
    },
    { type: "text", text: `INVENTORY (kind|headword|[reading|]meaning):\n${inventory}`, cache_control: { type: "ephemeral" } },
  ];
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["mappings"],
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["n", "label", "items"],
          properties: {
            n: { type: "integer" },
            label: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "headword", "reading"],
                properties: {
                  kind: { type: "string", enum: ["grammar", "vocab", "kanji"] },
                  headword: { type: "string" },
                  reading: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
  const client = new Anthropic();
  const BATCH = 25;
  let usage = { input: 0, cached: 0, output: 0 };
  for (let i = 0; i < toMap.length; i += BATCH) {
    const batch = toMap.slice(i, i + BATCH);
    const userText = batch
      .map((label, n) => {
        const ctx = distinctLabels.get(label);
        const note = ctx.note ? ` | note: ${ctx.note.replace(/\s+/g, " ").slice(0, 300)}` : "";
        return `${n + 1}. label: ${label} | section: ${ctx.section} | level: ${ctx.level}${note}`;
      })
      .join("\n");
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema } },
    });
    usage.input += res.usage.input_tokens;
    usage.cached += res.usage.cache_read_input_tokens ?? 0;
    usage.output += res.usage.output_tokens;
    const block = res.content.find((b) => b.type === "text");
    if (!block) throw new Error("Claude returned no text block");
    const { mappings } = JSON.parse(block.text);
    if (mappings.length !== batch.length) console.warn(`  ! batch sent ${batch.length} labels, got ${mappings.length} mappings`);
    const byN = new Map(mappings.map((m) => [m.n, m.items]));
    const byLabel = new Map(mappings.map((m) => [m.label.trim(), m.items]));
    batch.forEach((label, idx) => {
      const items = byN.get(idx + 1) ?? byLabel.get(label.trim()) ?? null;
      if (items === null) {
        console.warn(`  ! no mapping returned for: ${label}`);
        return;
      }
      cache[label] = items.slice(0, 3);
    });
    console.log(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(toMap.length / BATCH)} done`);
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
  console.log(`Mapping cached in ${cachePath} (tokens: ${usage.input} in, ${usage.cached} cache-read, ${usage.output} out).`);
} else if (toMap.length > 0) {
  console.log(`--no-claude: ${toMap.length} label(s) have no cached mapping and will stay unlinked.`);
}

/** Tags for a label: direct match, else cached Claude mapping. Each {kind, text, itemId}. */
function tagsFor(label) {
  const direct = resolveItem(label);
  if (direct) return [{ kind: direct.kind, text: itemById.get(direct.itemId).headword, itemId: direct.itemId }];
  const proposed = cache[label];
  if (!Array.isArray(proposed)) return [];
  const out = [];
  const seen = new Set();
  for (const p of proposed) {
    const id = resolveProposed(p);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: itemById.get(id).kind, text: itemById.get(id).headword, itemId: id });
  }
  return out;
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

const unresolved = new Map(); // label -> count
const genkiUpdates = new Map(); // itemId -> {ref, coverage}
let questions = 0;
let linkedQuestions = 0;
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
    const sectionRaw = get(row, "section");
    const section = normalizeSection(sectionRaw);
    const meta = section === "other" && sectionRaw && sectionRaw.toLowerCase() !== "other" ? { sectionRaw } : null;
    const levelRaw = get(row, "level").toUpperCase();
    const level = levelRaw === "N5" || levelRaw === "N4" ? levelRaw : null;
    const correct = parseResult(get(row, "result"));
    const note = get(row, "note") || null;
    const label = get(row, "grammar_point");
    const rootCause = correct === false ? inferCause(note, get(row, "root_cause")) : null;
    if (correct === false) {
      misses++;
      if (rootCause) classified++;
    }

    let tags = label ? tagsFor(label) : [];
    if (label && tags.length === 0) {
      unresolved.set(label, (unresolved.get(label) ?? 0) + 1);
      tags = [{ kind: "grammar", text: label, itemId: null }];
    }

    // The label is the only "question text" an import has; store it as the stem so the
    // session page reads sensibly.
    const [q] = await sql.query(
      `INSERT INTO practice_questions
         (session_id, number, section, stem, choices, correct_choice, user_choice, is_correct, explanation, tags, level, root_cause, note, meta)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, NULL, NULL, $5, NULL, $6::jsonb, $7, $8, $9, $10::jsonb) RETURNING id`,
      [session.id, number, section, label, correct, JSON.stringify(tags), level, rootCause, note, meta ? JSON.stringify(meta) : null],
    );
    questions++;

    const matched = tags.filter((t) => t.itemId);
    if (matched.length > 0) linkedQuestions++;
    for (const t of matched) {
      await sql.query(
        `INSERT INTO question_items (question_id, item_id, role) VALUES ($1, $2, 'tested') ON CONFLICT DO NOTHING`,
        [q.id, t.itemId],
      );
      if (correct !== null) {
        await sql.query(
          `INSERT INTO observations (item_id, source, kind, correct, occurred_at, meta)
           VALUES ($1, 'practice', 'answer', $2, $3, $4::jsonb)`,
          [t.itemId, correct, s.takenAt.toISOString(), JSON.stringify({ sessionId: session.id, questionId: q.id, surface: "import" })],
        );
        observations++;
      }
    }
    const ref = get(row, "genki_ref");
    const coverage = get(row, "genki_coverage");
    if (ref || coverage) {
      const grammarMatches = matched.filter((t) => t.kind === "grammar");
      const targets = grammarMatches.length > 0 ? grammarMatches : matched.slice(0, 1);
      for (const t of targets) {
        const prev = genkiUpdates.get(t.itemId) ?? {};
        genkiUpdates.set(t.itemId, { ref: ref || prev.ref, coverage: coverage || prev.coverage });
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

console.log(`Inserted ${sessions.size} sessions, ${questions} questions (${linkedQuestions} linked to items), ${observations} observations.`);
console.log(`Misses: ${misses}, root cause set on ${classified} (${misses - classified} left unclassified).`);
console.log(`Genki refs written to ${genkiUpdates.size} items.`);
if (unresolved.size > 0) {
  console.log(`\n${unresolved.size} label(s) matched no library item (no evidence written):`);
  for (const [text, n] of [...unresolved.entries()].sort((a, b) => b[1] - a[1])) {
    const proposed = Array.isArray(cache[text]) ? cache[text].map((p) => `${p.kind}:${p.headword}`).join(", ") : "not mapped";
    console.log(`  ${n}× ${text}  →  ${proposed || "(Claude: nothing fits)"}`);
  }
}
