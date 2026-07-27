// Builds data/seed/bunpro-crosswalk.json: Bunpro grammar-point id → our curated
// grammar-item headword. Two passes:
//   1. deterministic normalized-string matching (free, unambiguous-only)
//   2. Claude pairs the leftovers semantically (可能形 ↔ "Potential Form",
//      そうだ（伝聞） vs （様態） via Bunpro's meaning field), one API call
// The output is committed and human-reviewable; the runtime sync (lib/bunpro.ts)
// only ever reads this file — no fuzzy matching in production. Items are referenced
// by headword (stable across db reseeds), resolved to ids at sync time.
//
// Usage: npm run bunpro:crosswalk   (needs DATABASE_URL + ANTHROPIC_API_KEY)
import { readFile, writeFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import Anthropic from "@anthropic-ai/sdk";

const sql = neon(process.env.DATABASE_URL);
const catalog = JSON.parse(
  await readFile(new URL("../data/seed/bunpro-grammar.json", import.meta.url), "utf8"),
);

const items = await sql.query(
  `SELECT headword, level, meaning FROM items WHERE kind = 'grammar' ORDER BY level, headword`,
);
const points = catalog.points.filter((p) => p.level === "JLPT5" || p.level === "JLPT4");

const normalize = (s) =>
  s
    .normalize("NFKC")
    .replace(/[\s]+/gu, "")
    .replace(/^(verb|noun|adjective|い-adjective|な-adjective)?\+/iu, "")
    .replace(/[（(][^（()）]*[)）]\s*$/u, "")
    .replace(/^[〜～~]+/u, "")
    .replace(/[〜～~]+$/u, "")
    .replace(/[①②③④⑤]+$/u, "")
    .toLowerCase();

// Pass 1: deterministic matches, only when unambiguous in both directions.
const itemsByNorm = new Map();
for (const item of items) {
  const norm = normalize(item.headword);
  if (!norm) continue;
  if (!itemsByNorm.has(norm)) itemsByNorm.set(norm, []);
  itemsByNorm.get(norm).push(item);
}

const pairs = new Map(); // bpId -> { headword, method }
for (const point of points) {
  const candidates = [point.title, ...point.title.split(/[・]/u)].map(normalize).filter(Boolean);
  const hits = new Set();
  for (const norm of candidates) {
    const rows = itemsByNorm.get(norm);
    if (rows?.length === 1) hits.add(rows[0].headword);
  }
  if (hits.size === 1) pairs.set(point.id, { headword: [...hits][0], method: "string" });
}

const leftoverPoints = points.filter((p) => !pairs.has(p.id));
const coveredHeadwords = new Set([...pairs.values()].map((p) => p.headword));
console.log(`Pass 1 (string): ${pairs.size}/${points.length} points paired.`);

// Pass 2: Claude pairs the leftovers. It sees every headword (multiple Bunpro
// points may legitimately map to one item) but is told to skip when unsure.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["bunproId", "headword"],
        properties: {
          bunproId: { type: "integer" },
          headword: { type: "string" },
        },
      },
    },
  },
};

const prompt = `You are mapping Bunpro grammar points to a curated JLPT N5/N4 grammar list so SRS evidence can flow between them.

Below are (A) Bunpro grammar points that automated string matching could NOT pair, and (B) the full curated item list (headword · level · meaning). For each Bunpro point, output the ONE curated headword that teaches the same grammar pattern, or omit the point entirely if no curated item covers it (many Bunpro points — single particles, pronouns like これ/ここ, conjugation-class intros like る-Verb — have no counterpart; skipping is the correct answer for those).

Rules:
- headword must be copied EXACTLY from list B, including 〜 and any parentheticals.
- Multiple Bunpro points may map to the same headword (e.g. ている① and ている② both → 〜ている).
- Use the meanings to disambiguate lookalikes, e.g. そうだ hearsay (伝聞) vs appearance (様態), ため purpose (目的) vs reason (理由).
- Only pair when you are confident it is the same pattern, not merely related.

A. Unpaired Bunpro points (id · title · level · meaning):
${leftoverPoints.map((p) => `${p.id} · ${p.title} · ${p.level} · ${p.meaning ?? ""}`).join("\n")}

B. Curated items (headword · level · meaning):
${items.map((i) => `${i.headword} · ${i.level} · ${i.meaning}`).join("\n")}`;

const client = new Anthropic();
const res = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 8192,
  messages: [{ role: "user", content: prompt }],
  output_config: { format: { type: "json_schema", schema: SCHEMA } },
});
const block = res.content.find((b) => b.type === "text");
const aiPairs = JSON.parse(block.text).pairs;

const validHeadwords = new Set(items.map((i) => i.headword));
let aiAccepted = 0;
let aiRejected = 0;
for (const { bunproId, headword } of aiPairs) {
  const point = leftoverPoints.find((p) => p.id === bunproId);
  if (!point || !validHeadwords.has(headword) || pairs.has(bunproId)) {
    aiRejected++;
    continue;
  }
  pairs.set(bunproId, { headword, method: "claude" });
  coveredHeadwords.add(headword);
  aiAccepted++;
}
console.log(`Pass 2 (claude): ${aiAccepted} accepted, ${aiRejected} rejected (invalid id/headword).`);

const out = {
  builtAt: new Date().toISOString(),
  note: "bunproId -> curated grammar headword. Rebuild with npm run bunpro:crosswalk; hand-edits survive review, not rebuilds.",
  pairs: [...pairs.entries()]
    .map(([bunproId, { headword, method }]) => {
      const point = points.find((p) => p.id === bunproId);
      return { bunproId, bunproTitle: point.title, headword, method };
    })
    .sort((a, b) => a.bunproId - b.bunproId),
};
await writeFile(
  new URL("../data/seed/bunpro-crosswalk.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n",
);

console.log(`Total: ${pairs.size}/${points.length} Bunpro points paired.`);
console.log(`Item coverage: ${coveredHeadwords.size}/${items.length} curated grammar items.`);
const uncovered = items.filter((i) => !coveredHeadwords.has(i.headword));
if (uncovered.length > 0) {
  console.log("Uncovered items:", uncovered.map((i) => i.headword).join(" / "));
}
