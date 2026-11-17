import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractServedInstructions,
  INSTRUCTIONS_DOC_PATH,
  instructionsHash,
  loadServedInstructions,
  serveInstructions,
} from "./served-instructions.ts";

const BODY = "## Study ledger\n\n" + "Log every graded question. ".repeat(20).trim();

test("extract: returns only the text below the first --- line, trimmed, with one trailing newline", () => {
  const doc = `# Header for the human\n\nPaste nothing.\n\n---\n\n${BODY}\n\n\n`;
  assert.equal(extractServedInstructions(doc), `${BODY}\n`);
});

test("extract: splits at the first --- only; later rules stay in the body", () => {
  const body = `${BODY}\n\n---\n\nMore rules.`;
  const out = extractServedInstructions(`# H\n\n---\n${body}`);
  assert.equal(out, `${body}\n`);
});

test("extract: a header fenced block and inline dashes do not count as the separator", () => {
  const doc = "# H\n\n```text\nstub line --- with dashes\n```\n\n-- not it\n----\n\n---\n" + BODY;
  const out = extractServedInstructions(doc);
  assert.equal(out, `${BODY}\n`);
  assert.ok(!out.includes("stub line"));
});

test("extract: CRLF line endings are handled", () => {
  const doc = `# H\r\n\r\n---\r\n${BODY.replace(/\n/g, "\r\n")}\r\n`;
  assert.equal(extractServedInstructions(doc), `${BODY}\n`);
});

test("extract: no separator is an error, not the whole file", () => {
  assert.throws(() => extractServedInstructions(`# H\n\n${BODY}`), /no '---' line/);
});

test("extract: an empty or stub-sized body is an error, not an empty payload", () => {
  assert.throws(() => extractServedInstructions("# H\n\n---\n"), /0 characters/);
  assert.throws(() => extractServedInstructions("# H\n\n---\n\n   \n"), /0 characters/);
  assert.throws(() => extractServedInstructions("# H\n---\nshort"), /5 characters/);
});

test("hash: 12 hex chars, stable, changes with the text", () => {
  const h = instructionsHash("abc");
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(instructionsHash("abc"), h);
  assert.notEqual(instructionsHash("abd"), h);
});

test("serveInstructions: chars and hash describe the returned text", () => {
  const served = serveInstructions(`# H\n---\n${BODY}`);
  assert.equal(served.chars, served.instructions.length);
  assert.equal(served.hash, instructionsHash(served.instructions));
});

test("the real doc: header excluded, served block non-empty and starts at the ledger heading", async () => {
  const root = path.join(import.meta.dirname, "..");
  const doc = await readFile(path.join(root, INSTRUCTIONS_DOC_PATH), "utf8");
  const served = await loadServedInstructions(root);
  assert.ok(served.chars > 2000, `served block is only ${served.chars} chars`);
  assert.ok(served.instructions.startsWith("## "), "served block should start with its first heading");
  const header = doc.slice(0, doc.indexOf("\n---\n"));
  const headerLines = header
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 20);
  assert.ok(headerLines.length > 5, "expected a header with a stub above the --- line");
  for (const line of headerLines) {
    assert.ok(!served.instructions.includes(line), `header line leaked into the served block: ${line}`);
  }
  assert.equal(served.instructions, doc.slice(doc.indexOf("\n---\n") + 5).trim() + "\n");
});

test("loadServedInstructions: a missing file is a clear error naming the path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "served-instructions-"));
  try {
    await assert.rejects(loadServedInstructions(dir), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Could not read the instructions file/);
      assert.ok(e.message.includes(INSTRUCTIONS_DOC_PATH));
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
