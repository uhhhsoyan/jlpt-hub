// One-time fetch of Bunpro's grammar-point catalog into data/seed/bunpro-grammar.json.
// Uses the public (unauthenticated) frontend content endpoint, one request per id with
// a polite throttle. The Bunpro frontend API is community-sanctioned but undocumented;
// see docs/plans/05-bunpro-sync.md for the integration notes.
//
// Usage: npm run bunpro:catalog
import { writeFile } from "node:fs/promises";

const BASE = "https://api.bunpro.jp/api/frontend/reviewables/grammar_point";
const THROTTLE_MS = 150;
const MAX_ID = 1500; // Bunpro has ~1000 grammar points; hard stop well above that.
const GIVE_UP_AFTER_MISSES = 50; // consecutive 404s past the end of the catalog

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const points = [];
let misses = 0;

for (let id = 1; id <= MAX_ID && misses < GIVE_UP_AFTER_MISSES; id++) {
  await sleep(THROTTLE_MS);
  let res;
  try {
    res = await fetch(`${BASE}/${id}`);
  } catch (e) {
    console.error(`id ${id}: network error (${e.message}), retrying once`);
    await sleep(2000);
    res = await fetch(`${BASE}/${id}`);
  }
  if (res.status === 404) {
    misses++;
    continue;
  }
  if (res.status === 429) {
    console.error(`id ${id}: rate limited, backing off 30s`);
    await sleep(30_000);
    id--;
    continue;
  }
  if (!res.ok) {
    console.error(`id ${id}: unexpected ${res.status}, skipping`);
    continue;
  }
  misses = 0;
  const a = (await res.json()).data?.attributes;
  if (!a?.title) continue;
  points.push({
    id: a.id,
    title: a.title,
    slug: a.slug,
    level: a.level, // "JLPT5" ... "JLPT1" | "Non-JLPT"
    meaning: a.meaning ?? null,
    grammarOrder: a.grammar_order ?? null,
  });
  if (points.length % 50 === 0) console.log(`${points.length} points (at id ${id})`);
}

points.sort((x, y) => x.id - y.id);
await writeFile(
  new URL("../data/seed/bunpro-grammar.json", import.meta.url),
  JSON.stringify({ fetchedAt: new Date().toISOString(), points }, null, 2) + "\n",
);

const byLevel = {};
for (const p of points) byLevel[p.level] = (byLevel[p.level] ?? 0) + 1;
console.log(`Saved ${points.length} grammar points:`, byLevel);
