import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accessHeaders,
  classifyFailure,
  memoryRecall,
  memoryReflect,
  memoryUiUrl,
  readHindsightConfig,
  shapeRecall,
} from "./hindsight.ts";

test("readHindsightConfig: null without HINDSIGHT_URL, defaults and trimming otherwise", () => {
  assert.equal(readHindsightConfig({}), null);
  assert.equal(readHindsightConfig({ HINDSIGHT_URL: "  " }), null);
  const cfg = readHindsightConfig({ HINDSIGHT_URL: "https://api.example.com/ ", HINDSIGHT_UI_URL: "https://ui.example.com//" });
  assert.deepEqual(cfg, {
    baseUrl: "https://api.example.com",
    bank: "jlpt-study",
    apiKey: undefined,
    accessClientId: undefined,
    accessClientSecret: undefined,
    uiUrl: "https://ui.example.com",
  });
});

test("memoryUiUrl points at the bank page only when a UI origin is configured", () => {
  assert.equal(memoryUiUrl({}), null);
  assert.equal(memoryUiUrl({ HINDSIGHT_URL: "https://api.example.com" }), null);
  assert.equal(
    memoryUiUrl({ HINDSIGHT_URL: "https://api.example.com", HINDSIGHT_UI_URL: "https://ui.example.com", HINDSIGHT_BANK: "jlpt-study" }),
    "https://ui.example.com/banks/jlpt-study",
  );
});

test("accessHeaders: both halves or nothing", () => {
  assert.deepEqual(accessHeaders({}), {});
  assert.deepEqual(accessHeaders({ accessClientId: "id" }), {});
  assert.deepEqual(accessHeaders({ accessClientId: "id", accessClientSecret: "s" }), {
    "CF-Access-Client-Id": "id",
    "CF-Access-Client-Secret": "s",
  });
});

test("shapeRecall: limit, date from occurred_start then mentioned_at, trimmed text", () => {
  const hits = shapeRecall(
    [
      { text: " ほど rule \n", type: "world", occurred_start: "2026-11-03T10:00:00Z", document_id: "session:abc", entities: ["ほど"] },
      { text: "pattern", type: "observation", mentioned_at: "2026-11-04T00:00:00Z" },
      { text: "third" },
    ],
    2,
  );
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { text: "ほど rule", type: "world", when: "2026-11-03", documentId: "session:abc", entities: ["ほど"] });
  assert.deepEqual(hits[1], { text: "pattern", type: "observation", when: "2026-11-04", documentId: null, entities: [] });
});

test("classifyFailure separates misconfiguration from an unreachable server", () => {
  assert.equal(classifyFailure({ statusCode: 401, message: "Unauthorized" }).status, "rejected");
  assert.equal(classifyFailure({ statusCode: 403, message: "Forbidden" }).status, "rejected");
  assert.equal(classifyFailure({ statusCode: 530, message: "tunnel" }).status, "offline");
  assert.equal(classifyFailure({ statusCode: 503, message: "busy" }).status, "offline");
  const timeout = new Error("recall timed out after 20 s");
  timeout.name = "TimeoutError";
  assert.deepEqual(classifyFailure(timeout), { status: "offline", reason: "recall timed out after 20 s" });
  const loginPage = classifyFailure(new SyntaxError("Unexpected token < in JSON"));
  assert.equal(loginPage.status, "rejected");
  assert.match((loginPage as { reason: string }).reason, /Access/);
  assert.equal(classifyFailure(new TypeError("fetch failed")).status, "offline");
});

test("recall and reflect report unconfigured without touching the network", async () => {
  assert.equal((await memoryRecall("ほど", {}, {})).status, "unconfigured");
  assert.equal((await memoryReflect("what to drill?", {}, {})).status, "unconfigured");
});

test("recall reports offline (not a throw) when the server is unreachable", async () => {
  const res = await memoryRecall("ほど", { timeoutMs: 5000 }, { HINDSIGHT_URL: "http://127.0.0.1:9" });
  assert.equal(res.status, "offline");
});
