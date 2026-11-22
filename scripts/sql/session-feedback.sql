-- The feedback inbox (lib/db/schema.ts sessionFeedback). Generated with `drizzle-kit generate`
-- from the schema and made idempotent (IF NOT EXISTS); purely additive, touches no other table.
-- Applied by `npm run db:feedback-table` (scripts/feedback-table.mjs), one statement at a time.
CREATE TABLE IF NOT EXISTS "session_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"period_from" date,
	"period_to" date,
	"session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surface" text DEFAULT 'claude-ai' NOT NULL,
	"server_version" text NOT NULL,
	"resolution" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "session_feedback_status" ON "session_feedback" USING btree ("status","created_at");
