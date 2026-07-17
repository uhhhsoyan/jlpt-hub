import Anthropic from "@anthropic-ai/sdk";
import type { GeneratedSentence } from "@/lib/types";

/** Reused across calls; constructed lazily so a missing key doesn't break the build. */
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are a Japanese sentence coach for a learner preparing for the JLPT N4 exam (December 2026). Their aim is to build sentences they would actually say or think in daily life, then study them.

For each English sentence or thought the user gives you, return the structured object with:

- "n4": a version rewritten to stay within JLPT N4, which INCLUDES all N5 grammar and vocabulary. Use only vocabulary and grammar at N4 or below. "japanese" is the sentence; "reading" is its full reading in hiragana (use katakana only where the word itself is katakana) with NO kanji; "gloss" is a literal English translation of THIS N4 version, so the learner sees exactly what the simpler Japanese says.
- "withinLevel": true if the N4 version fully captures the meaning and nuance of the input using only N4-level language; false if you had to simplify or drop nuance to stay within N4.
- "faithful": the most natural Japanese that faithfully expresses the ORIGINAL English, even if it exceeds N4. "levelTag" is the approximate highest JLPT level of grammar/vocabulary it uses (N5-N1). "differsFromN4" is true if this meaningfully differs from the n4 version; when the input is already fully N4-expressible, the faithful version may match the n4 version, "levelTag" is "N4", and "differsFromN4" is false.
- "vocab": every content word in the N4 sentence, each with its reading (hiragana/katakana), a short English meaning, and its JLPT level. Use "other" for proper nouns or loanwords not on JLPT lists.
- "grammar": the grammar patterns used in the N4 sentence, each with its JLPT level and a one-line note on what it does.
- "notes": a brief plain-English note (1-3 sentences). If you simplified to hit N4, say what nuance changed. If the faithful version exceeds N4, name the construction and its level, e.g. "The faithful version uses ~ざるを得ない, an N2 pattern." If nothing was lost, say so briefly.

Rules:
- Write natural, conversational Japanese a real person would actually say, not stiff textbook phrasing.
- Use plain/casual or polite (です・ます) form as fits an everyday utterance, and keep the form consistent within a sentence.
- Never romanize. Readings are hiragana (or katakana for katakana words).
- Level tags are your best estimate. Grammar-level judgments in particular are approximate.
- Keep the N4 version genuinely at N4: if the input needs advanced grammar, simplify the idea rather than smuggling in higher-level structures.`;

/** JSON Schema for structured output. Strings/arrays/booleans only, additionalProperties:false everywhere. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["n4", "withinLevel", "faithful", "vocab", "grammar", "notes"],
  properties: {
    n4: {
      type: "object",
      additionalProperties: false,
      required: ["japanese", "reading", "gloss"],
      properties: {
        japanese: { type: "string" },
        reading: { type: "string" },
        gloss: { type: "string" },
      },
    },
    withinLevel: { type: "boolean" },
    faithful: {
      type: "object",
      additionalProperties: false,
      required: ["japanese", "reading", "levelTag", "differsFromN4"],
      properties: {
        japanese: { type: "string" },
        reading: { type: "string" },
        levelTag: { type: "string", enum: ["N5", "N4", "N3", "N2", "N1"] },
        differsFromN4: { type: "boolean" },
      },
    },
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
  return JSON.parse(block.text) as GeneratedSentence;
}
