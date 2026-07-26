import Anthropic from "@anthropic-ai/sdk";
import type { GeneratedSentence } from "@/lib/types";

/** Reused across calls; constructed lazily so a missing key doesn't break the build. */
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are a Japanese sentence coach for a learner studying JLPT N5 and N4 simultaneously (N4 exam December 2026). Their aim is to build sentences they would actually say or think in daily life, then study them.

For each English sentence or thought the user gives you, first translate it into the most natural Japanese ("faithful"), judge that translation's JLPT level, and return the structured object with:

- "faithful": the most natural Japanese that faithfully expresses the ORIGINAL English, whatever its level. "levelTag" is the approximate highest JLPT level of grammar/vocabulary it uses (N5-N1). "differs" is true if this meaningfully differs from the first study version below; when the input is expressible within N4, faithful may match that version and "differs" is false.
- "versions": the study version(s):
  - If the faithful translation stays within N4 (N4 includes all N5), return ONE version. It should normally match the faithful translation. Its "level" is the highest level it actually uses: "N5" when it is entirely N5 grammar and vocabulary, otherwise "N4".
  - If the faithful translation needs anything above N4, return TWO versions: first the best rewrite that stays within N4 (level "N4"), then a simpler rewrite that stays entirely within N5 (level "N5"). Both must be natural sentences a real person would say, not truncated fragments.
  - Each version carries: "japanese"; "reading" — the full reading in hiragana (katakana only where the word itself is katakana) with NO kanji; "gloss" — a literal English translation of THAT version, so the learner sees exactly what its Japanese says; "vocab" — every content word in the version with reading, short English meaning, and JLPT level ("other" for proper nouns or loanwords not on JLPT lists); "grammar" — the grammar patterns used, each with JLPT level and a one-line note on what it does.
- "withinLevel": true if the FIRST version fully captures the meaning and nuance of the input; false if it had to simplify or drop nuance.
- "notes": a brief plain-English note (1-3 sentences). Say which level the input naturally lands at; if you simplified, say what nuance changed; if the faithful version exceeds N4, name the construction and its level, e.g. "The faithful version uses ~ざるを得ない, an N2 pattern."

Rules:
- Write natural, conversational Japanese a real person would actually say, not stiff textbook phrasing.
- Use plain/casual or polite (です・ます) form as fits an everyday utterance, and keep the form consistent within a sentence.
- Never romanize. Readings are hiragana (or katakana for katakana words).
- Level tags are your best estimate. Grammar-level judgments in particular are approximate.
- Keep each version genuinely within its level: if the input needs advanced grammar, simplify the idea rather than smuggling in higher-level structures. Don't force N5 phrasing when the input is naturally N4 — one honest version beats two artificial ones.`;

/** JSON Schema for structured output. Strings/arrays/booleans only, additionalProperties:false everywhere. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["versions", "withinLevel", "faithful", "notes"],
  properties: {
    versions: {
      // 1-2 entries; the API's structured output doesn't support min/maxItems,
      // so the count is enforced by the prompt and checked after parsing.
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "japanese", "reading", "gloss", "vocab", "grammar"],
        properties: {
          level: { type: "string", enum: ["N5", "N4"] },
          japanese: { type: "string" },
          reading: { type: "string" },
          gloss: { type: "string" },
          vocab: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["word", "reading", "meaning", "level"],
              properties: {
                word: { type: "string" },
                reading: { type: "string" },
                meaning: { type: "string" },
                level: { type: "string", enum: ["N5", "N4", "N3", "N2", "N1", "other"] },
              },
            },
          },
          grammar: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pattern", "level", "note"],
              properties: {
                pattern: { type: "string" },
                level: { type: "string", enum: ["N5", "N4", "N3", "N2", "N1"] },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
    withinLevel: { type: "boolean" },
    faithful: {
      type: "object",
      additionalProperties: false,
      required: ["japanese", "reading", "levelTag", "differs"],
      properties: {
        japanese: { type: "string" },
        reading: { type: "string" },
        levelTag: { type: "string", enum: ["N5", "N4", "N3", "N2", "N1"] },
        differs: { type: "boolean" },
      },
    },
    notes: { type: "string" },
  },
} as const;

export async function generateSentence(englishInput: string): Promise<GeneratedSentence> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: englishInput }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });

  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("The model returned no text output.");
  }
  const data = JSON.parse(block.text) as GeneratedSentence;
  if (data.versions.length === 0) throw new Error("The model returned no study versions.");
  data.versions = data.versions.slice(0, 2);
  return data;
}
