// Seeds the study_sources catalog from data/seed/study-sources.json. Idempotent: upserts
// on slug, updating name / kind / level / edition / url / color / aliases / sort_order /
// description / how_used / notes. image_url is only written when the seed has one, so a
// photo uploaded or set in the Hub survives a re-seed; `active` is never touched (hiding
// a source is a Hub decision, not a seed one).
//
// Usage: npm run db:seed-sources   (node --env-file=.env.local scripts/seed-study-sources.mjs)
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = join(root, "data", "seed", "study-sources.json");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(url);

const KINDS = new Set(["textbook", "workbook", "question-bank", "official-test", "app", "reader"]);

const entries = JSON.parse(readFileSync(seedPath, "utf8"));
const slugs = new Set();
for (const e of entries) {
  if (!e.slug || !e.name || !KINDS.has(e.kind)) {
    console.error(`Bad seed entry: ${JSON.stringify(e).slice(0, 120)}`);
    process.exit(1);
  }
  if (slugs.has(e.slug)) {
    console.error(`Duplicate slug in seed: ${e.slug}`);
    process.exit(1);
  }
  slugs.add(e.slug);
}

let inserted = 0;
let updated = 0;
for (const e of entries) {
  const rows = await sql.query(
    `
    INSERT INTO study_sources
      (slug, name, name_ja, kind, level, edition, url, image_url, color, aliases, sort_order, description, how_used, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      name_ja = EXCLUDED.name_ja,
      kind = EXCLUDED.kind,
      level = EXCLUDED.level,
      edition = EXCLUDED.edition,
      url = EXCLUDED.url,
      image_url = coalesce(EXCLUDED.image_url, study_sources.image_url),
      color = EXCLUDED.color,
      aliases = EXCLUDED.aliases,
      sort_order = EXCLUDED.sort_order,
      description = EXCLUDED.description,
      how_used = EXCLUDED.how_used,
      notes = EXCLUDED.notes
    RETURNING (xmax = 0) AS inserted
    `,
    [
      e.slug,
      e.name,
      e.nameJa ?? null,
      e.kind,
      e.level ?? null,
      e.edition ?? null,
      e.url ?? null,
      e.imageUrl ?? null,
      e.color ?? null,
      JSON.stringify(e.aliases ?? []),
      e.sortOrder ?? 0,
      e.description ?? null,
      e.howUsed ?? null,
      e.notes ?? null,
    ],
  );
  if (rows[0]?.inserted) inserted += 1;
  else updated += 1;
  console.log(`${rows[0]?.inserted ? "insert" : "update"}: ${e.slug}  ${e.name}`);
}

const [{ n }] = await sql.query(`SELECT count(*)::int AS n FROM study_sources`);
console.log(`\nstudy_sources: ${inserted} inserted, ${updated} updated, ${n} total.`);
