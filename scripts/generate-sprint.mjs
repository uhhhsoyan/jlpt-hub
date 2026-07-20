// Generates level-validated example sentences for vocab items that don't have one yet,
// in frequency-ish order (verbs first, N5 before N4), and inserts them into
// sprint_sentences grouped into decks ("chunks") of 100. Sentences are produced by the
// Anthropic API (structured output) and validated with kuromoji against the N5/N4 word
// list; sentences that still fail after one retry round are saved anyway with
// validated=false. Audio is added separately by scripts/tts-sprint.mjs.
//
// Usage: npm run sprint:generate -- [--count N] [--model M] [--dry-run]
//   (node --env-file=.env.local scripts/generate-sprint.mjs)
import { neon } from "@neondatabase/serverless";
import Anthropic from "@anthropic-ai/sdk";
import kuromoji from "kuromoji";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- CLI flags ---
function parseArgs(argv) {
  const args = { count: 100, model: "claude-sonnet-5", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") args.count = parseInt(argv[++i], 10);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
  }
  if (!Number.isFinite(args.count) || args.count <= 0) args.count = 100;
  return args;
}
const args = parseArgs(process.argv.slice(2));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(url);

// --- Anthropic client + prompt/schema (call shape mirrors lib/anthropic.ts) ---
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

const SYSTEM_PROMPT = `You write ONE short, natural, daily-life Japanese sentence per target word for a JLPT N4 learner.

Hard constraints:
- The sentence CONTAINS the target word.
- Use ONLY N5/N4-level vocabulary and grammar (N5-level function words are fine).
- The Japanese sentence is 8-35 characters long.
- Use polite or plain form, and stay consistent within a sentence.
- "reading" is the full sentence written in kana only (katakana words stay katakana; no kanji).
- "english" is a natural translation of the sentence.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentences"],
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headword", "japanese", "reading", "english"],
        properties: {
          headword: { type: "string" },
          japanese: { type: "string" },
          reading: { type: "string" },
          english: { type: "string" },
        },
      },
    },
  },
};

/** One call to the model; returns a Map keyed by headword. */
async function callModel(model, userContent) {
  const res = await getClient().messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("The model returned no text output.");
  const parsed = JSON.parse(block.text);
  const map = new Map();
  for (const s of parsed.sentences ?? []) {
    if (s && typeof s.headword === "string") map.set(s.headword, s);
  }
  return map;
}

async function generateBatch(batch, model) {
  const targets = batch.map((item) => ({
    headword: item.headword,
    reading: item.reading,
    meaning: item.meaning,
  }));
  return callModel(model, JSON.stringify(targets));
}

async function retryBatch(retryEntries, model) {
  const targets = retryEntries.map(({ item, sentence, validation }) => {
    const note = validation.missingTarget
      ? `Your previous sentence for ${item.headword} ("${sentence.japanese}") did not contain the target word. Write a new sentence that includes it.`
      : `Your previous sentence for ${item.headword} ("${sentence.japanese}") used words outside the JLPT N5/N4 list: ${validation.violations.join("、")}. Write a new sentence avoiding them.`;
    return { headword: item.headword, reading: item.reading, meaning: item.meaning, note };
  });
  return callModel(model, JSON.stringify(targets));
}

// --- kana normalization + kuromoji-based validation ---
function kataToHira(s) {
  return String(s ?? "").replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

const LEVEL_CHECK_POS = new Set(["名詞", "動詞", "形容詞", "副詞"]);
const ALLOWED_POS_DETAIL_1 = new Set(["数", "代名詞", "非自立", "接尾"]);
const ASCII_DIGITS_RE = /^[0-9A-Za-z]+$/;
const SINGLE_HIRAGANA_RE = /^[ぁ-ゖ]$/;
const KANJI_RE = /[一-鿿]/;

// Counter/suffix entries are listed as 〜人, 〜側 etc. — the tilde is citation notation,
// never something the tokenizer produces. Strip it for all matching.
const stripTilde = (s) => s.replace(/^[〜～]+/, "").replace(/[〜～]+$/, "");

function buildVocabLookup(vocabItems) {
  const headwords = new Set(vocabItems.map((v) => stripTilde(v.headword)));
  const readingsHira = new Set(
    vocabItems.map((v) => kataToHira(stripTilde(v.reading))).filter((r) => r.length > 0),
  );
  return { headwords, readingsHira };
}

function isAllowedToken(t, vocabLookup) {
  if (!LEVEL_CHECK_POS.has(t.pos)) return true;
  if (vocabLookup.headwords.has(t.basic_form) || vocabLookup.headwords.has(t.surface_form)) {
    return true;
  }
  const normSurf = kataToHira(t.surface_form);
  const normBasic = kataToHira(t.basic_form);
  const normRead = kataToHira(t.reading);
  if (
    vocabLookup.readingsHira.has(normSurf) ||
    vocabLookup.readingsHira.has(normBasic) ||
    vocabLookup.readingsHira.has(normRead)
  ) {
    return true;
  }
  if (ALLOWED_POS_DETAIL_1.has(t.pos_detail_1)) return true;
  if (ASCII_DIGITS_RE.test(t.surface_form)) return true;
  if (t.surface_form.length === 1 && SINGLE_HIRAGANA_RE.test(t.surface_form)) return true;
  return false;
}

function checkContainment(tokens, item) {
  const target = stripTilde(item.headword);
  const isKanaOnly = !KANJI_RE.test(target);
  const targetReadingHira = kataToHira(stripTilde(item.reading));
  for (const t of tokens) {
    if (t.basic_form === target || t.surface_form === target) return true;
    if (isKanaOnly && targetReadingHira) {
      if (kataToHira(t.surface_form) === targetReadingHira) return true;
      if (kataToHira(t.reading) === targetReadingHira) return true;
    }
  }
  return false;
}

function validateSentence(japanese, item, tokenizer, vocabLookup) {
  const tokens = tokenizer.tokenize(japanese);
  const contained = checkContainment(tokens, item);
  const violations = [];
  for (const t of tokens) {
    if (!isAllowedToken(t, vocabLookup)) violations.push(t.basic_form);
  }
  const uniqueViolations = [...new Set(violations)];
  return {
    valid: contained && uniqueViolations.length === 0,
    missingTarget: !contained,
    violations: uniqueViolations,
  };
}

function buildTokenizer(dicPath) {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      if (err) reject(err);
      else resolve(tokenizer);
    });
  });
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- Load candidates ---
const vocabItems = await sql.query(
  `SELECT id, level, headword, reading, romaji, meaning, detail FROM items WHERE kind = 'vocab'`,
);
const existingSentences = await sql.query(`SELECT item_id, chunk, position FROM sprint_sentences`);
const existingItemIds = new Set(existingSentences.map((r) => r.item_id));
const existingCount = existingSentences.length;

const candidates = vocabItems.filter((v) => !existingItemIds.has(v.id));

const posRank = (v) => (v.detail && v.detail.pos === "verb" ? 0 : 1);
const levelRank = (v) => (v.level === "N5" ? 0 : 1);
candidates.sort((a, b) => {
  const p = posRank(a) - posRank(b);
  if (p !== 0) return p;
  const l = levelRank(a) - levelRank(b);
  if (l !== 0) return l;
  const r = cmpStr(a.reading ?? "", b.reading ?? "");
  if (r !== 0) return r;
  return cmpStr(a.headword, b.headword);
});

const selected = candidates.slice(0, args.count).map((v, index) => {
  const seq = existingCount + index;
  return { ...v, seq, chunk: Math.floor(seq / 100), position: seq % 100 };
});

if (args.dryRun) {
  console.log(`Dry run: ${candidates.length} candidate(s) available, requested ${args.count}.`);
  console.log(`Planned batch (${selected.length} item(s)):`);
  for (const v of selected) {
    const pos = v.detail?.pos ?? "-";
    console.log(
      `  seq=${v.seq} chunk=${v.chunk} pos=${v.position}  [${v.level} ${pos}]  ${v.headword} (${v.reading})  — ${v.meaning}`,
    );
  }
  process.exit(0);
}

if (selected.length === 0) {
  console.log("No candidate vocab items without a sprint sentence. Nothing to do.");
  process.exit(0);
}

// --- Build tokenizer + full vocab lookup once ---
const tokenizer = await buildTokenizer(join(root, "node_modules", "kuromoji", "dict"));
const vocabLookup = buildVocabLookup(vocabItems);

const batches = chunkArray(selected, 10);

const finalResults = []; // { item, sentence, validated }
const failedGeneration = []; // items with no sentence at all
const failedValidation = []; // { headword, violations, missingTarget } — still invalid after retry

for (const batch of batches) {
  let generated;
  try {
    generated = await generateBatch(batch, args.model);
  } catch (err) {
    console.error(`Batch generation failed (seq ${batch[0].seq}-${batch[batch.length - 1].seq}): ${err.message}`);
    failedGeneration.push(...batch);
    continue;
  }

  const toValidate = [];
  for (const item of batch) {
    const sentence = generated.get(item.headword);
    if (!sentence) {
      failedGeneration.push(item);
      continue;
    }
    toValidate.push({ item, sentence });
  }

  const needsRetry = [];
  for (const { item, sentence } of toValidate) {
    const validation = validateSentence(sentence.japanese, item, tokenizer, vocabLookup);
    if (validation.valid) {
      finalResults.push({ item, sentence, validated: true });
    } else {
      needsRetry.push({ item, sentence, validation });
    }
  }

  if (needsRetry.length === 0) continue;

  let retryGenerated = new Map();
  try {
    retryGenerated = await retryBatch(needsRetry, args.model);
  } catch (err) {
    console.error(`Retry generation failed (batch of ${needsRetry.length}): ${err.message}`);
  }

  for (const entry of needsRetry) {
    const { item, sentence: oldSentence, validation: oldValidation } = entry;
    const newSentence = retryGenerated.get(item.headword);
    const sentenceToUse = newSentence ?? oldSentence;
    const validation = newSentence
      ? validateSentence(newSentence.japanese, item, tokenizer, vocabLookup)
      : oldValidation;
    finalResults.push({ item, sentence: sentenceToUse, validated: validation.valid });
    if (!validation.valid) {
      failedValidation.push({
        headword: item.headword,
        violations: validation.violations,
        missingTarget: validation.missingTarget,
      });
    }
  }
}

// --- Insert via unnest batch (mirrors seed-items.mjs) ---
if (finalResults.length > 0) {
  const cols = { itemId: [], japanese: [], reading: [], english: [], chunk: [], position: [], validated: [] };
  for (const { item, sentence, validated } of finalResults) {
    cols.itemId.push(item.id);
    cols.japanese.push(sentence.japanese);
    cols.reading.push(sentence.reading);
    cols.english.push(sentence.english);
    cols.chunk.push(item.chunk);
    cols.position.push(item.position);
    cols.validated.push(validated);
  }
  await sql.query(
    `INSERT INTO sprint_sentences (item_id, japanese, reading, english, chunk, position, validated)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::bool[])
     ON CONFLICT (item_id) DO NOTHING`,
    [cols.itemId, cols.japanese, cols.reading, cols.english, cols.chunk, cols.position, cols.validated],
  );
}

// --- Report ---
const validatedCount = finalResults.filter((r) => r.validated).length;
const notValidatedCount = finalResults.length - validatedCount;
const chunksWritten = [...new Set(finalResults.map((r) => r.item.chunk))].sort((a, b) => a - b);

console.log(`Requested: ${args.count}, candidates available: ${candidates.length}`);
console.log(`Generated: ${finalResults.length} sentence(s), failed generation (skipped): ${failedGeneration.length}`);
console.log(`Validated: ${validatedCount}, not validated: ${notValidatedCount}`);
console.log(`Chunks written: ${chunksWritten.join(", ") || "(none)"}`);

if (failedGeneration.length > 0) {
  console.log(`Failed-generation lemmas (max 10): ${failedGeneration.slice(0, 10).map((i) => i.headword).join(", ")}`);
}

if (failedValidation.length > 0) {
  console.log(`Still-invalid after retry (max 10):`);
  for (const f of failedValidation.slice(0, 10)) {
    const reason = f.missingTarget ? "missing target word" : `violations: ${f.violations.join("、")}`;
    console.log(`  ${f.headword} — ${reason}`);
  }
}
