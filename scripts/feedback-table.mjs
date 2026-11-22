// Creates the feedback inbox table (session_feedback) and its index, exactly as written in
// scripts/sql/session-feedback.sql. Idempotent (IF NOT EXISTS) and additive: it touches no
// other table, so it is safe where `npm run db:push` would also try to reconcile other drift.
//
// Usage: npm run db:feedback-table   (node --env-file=.env.local scripts/feedback-table.mjs)
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlPath = join(root, "scripts", "sql", "session-feedback.sql");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(url);

// One statement per entry: drop comment lines, split on the semicolon that ends a statement
// (the file has no semicolons inside literals).
const statements = readFileSync(sqlPath, "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean);

await sql.transaction(statements.map((s) => sql.query(s)));
const [check] = await sql.query(
  "select count(*)::int as n from information_schema.columns where table_name = 'session_feedback'",
);
console.log(`Applied ${statements.length} statements from scripts/sql/session-feedback.sql; session_feedback has ${check.n} columns.`);
