// One-off for sessions logged before practice_sessions.source_id existed: resolve each
// session's free-text source_name against the study_sources catalog (same resolver the
// MCP tools use, lib/study-sources.ts) and set source_id where it is still null.
// Idempotent: rows that already have a source_id are skipped, so running it twice (or
// after adding an alias and re-seeding) only touches what was unresolved before.
// Prints every match and every miss so an alias can be added for the misses.
//
// Usage: npm run db:backfill-sources
//        (node --env-file=.env.local --import tsx scripts/backfill-session-sources.mts)
import { neon } from "@neondatabase/serverless";
import { resolveSource, type SourceLike } from "../lib/study-sources";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(url);

const sources = (await sql.query(`SELECT id, slug, name, name_ja AS "nameJa", aliases FROM study_sources`)) as SourceLike[];
if (sources.length === 0) {
  console.error("study_sources is empty: run `npm run db:seed-sources` first.");
  process.exit(1);
}

const sessions = (await sql.query(`
  SELECT id, label, source_name
  FROM practice_sessions
  WHERE source_id IS NULL AND source_name IS NOT NULL AND btrim(source_name) <> ''
  ORDER BY taken_at
`)) as { id: string; label: string; source_name: string }[];

let matched = 0;
const misses = new Map<string, number>();
for (const s of sessions) {
  const source = resolveSource(sources, s.source_name);
  if (!source) {
    misses.set(s.source_name, (misses.get(s.source_name) ?? 0) + 1);
    continue;
  }
  await sql.query(`UPDATE practice_sessions SET source_id = $1 WHERE id = $2 AND source_id IS NULL`, [source.id, s.id]);
  matched += 1;
  console.log(`link: ${s.id}  "${s.label}"  ${JSON.stringify(s.source_name)} -> ${source.slug}`);
}

for (const [text, n] of misses) console.log(`miss: ${JSON.stringify(text)}  (${n} session${n === 1 ? "" : "s"})`);
console.log(
  `\n${sessions.length} unlinked session(s) with a source_name: ${matched} linked, ${sessions.length - matched} still unresolved.` +
    (misses.size > 0 ? " Add an alias to data/seed/study-sources.json, re-seed, and run again." : ""),
);
