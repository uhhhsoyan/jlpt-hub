import { test } from "node:test";
import assert from "node:assert/strict";
import { insightMatch, rankInsights, type InsightCandidate } from "./insight-match.ts";

interface Row extends InsightCandidate {
  id: string;
}

const day = (d: number) => new Date(Date.UTC(2026, 10, d));
const rows: Row[] = [
  { id: "shy", text: "Read はずかしい as はず + かしい; it is one adjective, embarrassed.", tags: ["vocab", "misparse"], itemIds: [], createdAt: day(12) },
  { id: "hazu-item", text: "Picked つもり where certainty was needed.", tags: ["expectation"], itemIds: ["hazu"], createdAt: day(5) },
  { id: "hazu-tag", text: "Expectation vs intention under time pressure.", tags: ["はず", "time-pressure"], itemIds: [], createdAt: day(8) },
  { id: "hazu-text", text: "はずがない is the strong negative of はず.", tags: ["expectation", "polarity"], itemIds: [], createdAt: day(3) },
  { id: "hodo", text: "ほど marks the standard that is not reached.", tags: ["comparison", "Polarity"], itemIds: ["hodo"], createdAt: day(10) },
];

test("insightMatch: item beats tag beats text, tag match is case-insensitive", () => {
  assert.equal(insightMatch(rows[1], "はず", ["hazu"]), "item");
  assert.equal(insightMatch(rows[2], "はず", ["hazu"]), "tag");
  assert.equal(insightMatch(rows[3], "はず", ["hazu"]), "text");
  assert.equal(insightMatch(rows[0], "はず", ["hazu"]), "text");
  assert.equal(insightMatch(rows[4], "polarity"), "tag");
  assert.equal(insightMatch(rows[4], "はず", ["hazu"]), null);
  assert.equal(insightMatch(rows[4], "  "), null);
  // Any of several topic items counts (から means both から senses).
  assert.equal(insightMatch(rows[4], "x", ["kara-kiten", "hodo"]), "item");
});

test("rankInsights: item and tag matches first (newest first), text-only matches after, none dropped", () => {
  const got = rankInsights(rows, { topic: "はず", topicItemIds: ["hazu"] });
  assert.deepEqual(
    got.map((r) => [r.row.id, r.matched]),
    [
      ["hazu-tag", "tag"],
      ["hazu-item", "item"],
      // はずかしい is newer than the genuine はずがない note but only a text hit, so it ranks with the text hits.
      ["shy", "text"],
      ["hazu-text", "text"],
    ],
  );
});

test("rankInsights: no topic means newest first with no matched label", () => {
  const got = rankInsights(rows, {});
  assert.deepEqual(
    got.map((r) => r.row.id),
    ["shy", "hodo", "hazu-tag", "hazu-item", "hazu-text"],
  );
  assert.ok(got.every((r) => r.matched === undefined));
});

test("rankInsights: tags is an AND-filter, case-insensitive, combinable with a topic", () => {
  assert.deepEqual(
    rankInsights(rows, { tags: ["polarity"] }).map((r) => r.row.id),
    ["hodo", "hazu-text"],
  );
  assert.deepEqual(
    rankInsights(rows, { tags: ["Expectation", "polarity"] }).map((r) => r.row.id),
    ["hazu-text"],
  );
  assert.deepEqual(rankInsights(rows, { tags: ["expectation", "nonexistent"] }), []);
  // Blank tags are ignored rather than matching nothing.
  assert.equal(rankInsights(rows, { tags: [" ", ""] }).length, rows.length);
  assert.deepEqual(
    rankInsights(rows, { topic: "はず", topicItemIds: ["hazu"], tags: ["expectation"] }).map((r) => [r.row.id, r.matched]),
    [
      ["hazu-item", "item"],
      ["hazu-text", "text"],
    ],
  );
});

test("rankInsights: limit applies after ranking and is clamped", () => {
  assert.deepEqual(
    rankInsights(rows, { topic: "はず", topicItemIds: ["hazu"], limit: 1 }).map((r) => r.row.id),
    ["hazu-tag"],
  );
  assert.equal(rankInsights(rows, { limit: 0 }).length, 1);
});
