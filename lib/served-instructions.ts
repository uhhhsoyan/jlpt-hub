import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The claude.ai side's instructions, served by the MCP `get_instructions` tool instead of
 * being pasted into the "Japanese Study" project. The single source of truth stays
 * docs/claude-ai-project-instructions.md (reviewed in PRs): everything below its first `---`
 * line is what the model gets; the header above it is for the human.
 *
 * The file is read at request time from the deployment's own copy, so it always matches the
 * deployed commit. On Vercel it is only in the function bundle because next.config.ts lists
 * it in `outputFileTracingIncludes` for `/mcp`; keep the two paths in sync.
 *
 * Pure apart from the one readFile (no DB, no path aliases) so it unit-tests under plain
 * `node --test`.
 */
export const INSTRUCTIONS_DOC_PATH = "docs/claude-ai-project-instructions.md";

/** Body under this many characters is treated as broken, not served. */
const MIN_INSTRUCTIONS_CHARS = 200;

export interface ServedInstructions {
  /** sha256 of `instructions`, first 12 hex chars: changes whenever the served text does. */
  hash: string;
  /** Character count of `instructions` (UTF-16 code units, as JS counts them). */
  chars: number;
  instructions: string;
}

/**
 * The served block: the text after the first line that is exactly `---`, trimmed. Throws
 * when there is no such line or nothing substantial under it, so a malformed doc is an
 * error, never an empty or header-only payload.
 */
export function extractServedInstructions(doc: string): string {
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const sep = lines.findIndex((line) => line.trim() === "---");
  if (sep === -1) {
    throw new Error(`${INSTRUCTIONS_DOC_PATH} has no '---' line separating the header from the served instructions`);
  }
  const body = lines
    .slice(sep + 1)
    .join("\n")
    .trim();
  if (body.length < MIN_INSTRUCTIONS_CHARS) {
    throw new Error(
      `${INSTRUCTIONS_DOC_PATH} has ${body.length} characters below its '---' line; expected the full instructions block`,
    );
  }
  return `${body}\n`;
}

export function instructionsHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export function serveInstructions(doc: string): ServedInstructions {
  const instructions = extractServedInstructions(doc);
  return { hash: instructionsHash(instructions), chars: instructions.length, instructions };
}

/**
 * Read and extract the doc from `root` (the project root: process.cwd() under `next start`
 * and in the Vercel function). Any failure (missing file, malformed doc) throws an Error
 * naming the path, for the tool to return as an error result.
 */
export async function loadServedInstructions(root: string = process.cwd()): Promise<ServedInstructions> {
  const file = path.join(root, INSTRUCTIONS_DOC_PATH);
  let doc: string;
  try {
    doc = await readFile(file, "utf8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read the instructions file (${INSTRUCTIONS_DOC_PATH}) in this deployment: ${reason}. ` +
        "It is probably missing from the function bundle (outputFileTracingIncludes for /mcp in next.config.ts).",
    );
  }
  return serveInstructions(doc);
}
