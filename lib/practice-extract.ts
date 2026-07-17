import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedQuestion } from "@/lib/types";

/** Reused across calls; constructed lazily so a missing key doesn't break the build. */
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

const MODEL = "claude-opus-4-8";

const SUPPORTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface PracticeImage {
  /** e.g. "image/jpeg" — caller is responsible for rejecting unsupported types (HEIC) upstream. */
  mediaType: string;
  /** Raw base64, no data: URL prefix. */
  base64: string;
}

export interface ExtractContext {
  sourceName?: string;
  label: string;
}

function systemPrompt(): string {
  return `You are an expert JLPT tutor digitizing a learner's completed practice-book pages. The photos usually come from Shin Nihongo 500 Mon (N4-N5): numbered multiple-choice questions split across three daily sections — 文字 (kanji), 語彙 (vocabulary), 文法 (grammar) — sometimes alongside reading or listening questions. The learner may also photograph an official JLPT practice workbook page, or an answer-key page with explanations; use whatever is visible across all the photos together to fill in as much as you can.

Treat all the photos as one set — a question's answer key may be on a different page than its prompt, so cross-reference by question number across images.

For EVERY numbered question visible in any of the images, extract:

- "number": the question's printed number (an integer, not a running count you invent).
- "section": one of "kanji", "vocab", "grammar", "reading", "listening", "other" — your best guess from the page layout, heading, or content.
- "stem": the question text, verbatim Japanese. Use （　） (a Japanese-bracketed blank) for any fill-in-the-blank underline or blank space in the original.
- "choices": the answer choices, verbatim Japanese, in their printed order.
- "correctChoice": the 0-based index into "choices" of the correct answer, read from an answer-key page or any markings that indicate it. null if you cannot determine it from what's photographed.
- "userChoice": the 0-based index of the choice the learner marked — a circle, checkmark, underline, or a handwritten number next to a choice. These pencil marks are often faint; look carefully. null if no mark is visible or it's not legible.
- "explanation": a brief English explanation (1-2 sentences) of why the correct answer is right, naming the grammar point or vocabulary being tested. Empty string if you have no basis for one (e.g. no answer key visible for this question).
- "tags": 1 to 3 objects, each {"kind": "vocab" | "kanji" | "grammar", "text": "..."}, naming the specific word, kanji character, or grammar pattern the question is really testing. Write "text" in canonical dictionary/citation form — e.g. the plain dictionary form of a verb, a single bare kanji character, "〜ておく" for a grammar pattern — not an inflected or example-sentence form.

Rules:
- If genuinely ambiguous, prefer null over a guess for correctChoice/userChoice.
- Do not invent or fabricate a question that isn't legible; skip anything you truly cannot read rather than guessing at a stem.
- Cross-reference question pages against answer-key pages by question number when both are photographed.`;
}

/** JSON Schema for structured output. additionalProperties:false everywhere per project convention. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "number",
          "section",
          "stem",
          "choices",
          "correctChoice",
          "userChoice",
          "explanation",
          "tags",
        ],
        properties: {
          number: { type: "integer" },
          section: {
            type: "string",
            enum: ["kanji", "vocab", "grammar", "reading", "listening", "other"],
          },
          stem: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          correctChoice: { type: ["integer", "null"] },
          userChoice: { type: ["integer", "null"] },
          explanation: { type: "string" },
          tags: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "text"],
              properties: {
                kind: { type: "string", enum: ["vocab", "kanji", "grammar"] },
                text: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

function toImageBlock(image: PracticeImage): Anthropic.ImageBlockParam {
  if (!SUPPORTED_MEDIA_TYPES.has(image.mediaType)) {
    throw new Error(`Unsupported image type for extraction: ${image.mediaType}`);
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType as "image/jpeg" | "image/png" | "image/webp",
      data: image.base64,
    },
  };
}

/** One Claude vision call over all pages of a practice session; returns every question found. */
export async function extractQuestions(
  images: PracticeImage[],
  context: ExtractContext,
): Promise<ExtractedQuestion[]> {
  if (images.length === 0) return [];

  const contextLines = [
    `Session label: ${context.label}`,
    context.sourceName ? `Source: ${context.sourceName}` : null,
    `Extract every question visible across these ${images.length} image(s).`,
  ].filter((line): line is string => line != null);

  const content: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [
    ...images.map(toImageBlock),
    { type: "text", text: contextLines.join("\n") },
  ];

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt(),
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });

  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("The model returned no text output.");
  }
  const parsed = JSON.parse(block.text) as { questions: ExtractedQuestion[] };
  return parsed.questions;
}
