// One-off for sessions logged before practice_sessions.mode existed: any session whose
// attempts carry meta.mode = "lesson" (the convention the first claude.ai session used)
// becomes mode='lesson', and the graded 'answer' observations it wrote are turned into
// 'exposure' so they stop counting toward accuracy. Idempotent.
//
// Usage: node --env-file=.env.local scripts/migrate-lesson-sessions.mjs
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const sql = neon(url);

const sessions = await sql.query(`
  UPDATE practice_sessions s
  SET mode = 'lesson'
  WHERE s.mode <> 'lesson'
    AND EXISTS (SELECT 1 FROM practice_questions q WHERE q.session_id = s.id AND q.meta->>'mode' = 'lesson')
  RETURNING s.id, s.label
`);
for (const s of sessions) console.log(`lesson: ${s.id} ${s.label}`);

const obs = await sql.query(`
  UPDATE observations o
  SET kind = 'exposure', meta = coalesce(o.meta, '{}'::jsonb) || '{"mode":"lesson"}'::jsonb
  WHERE o.kind = 'answer'
    AND o.source = 'practice'
    AND (o.meta->>'sessionId') IN (SELECT id::text FROM practice_sessions WHERE mode = 'lesson')
  RETURNING o.id
`);
console.log(`sessions switched to lesson: ${sessions.length}; answer observations turned into exposure: ${obs.length}`);
