# 09 — Vocab queue

Status: built 2026-11-09 (schema, MCP tools, Hub page, backfill).

## Why

Words Eric did not know were being mentioned inside attempt notes and, from 2026-11-05, in
insights tagged `anki-queue` ("→ Anki" prose lists). Neither is a list you can review, and
missed vocab on open-book lessons never reaches the weak list (lesson mode is exposure only).
Eric wants one place that captures every "I didn't know that word", to review by hand and
turn into Anki cards.

## Shape

- Table `vocab_queue` (lib/db/schema.ts): one row per NFKC-normalised word (`norm`, unique),
  `text`, `reading`, `meaning`, optional `item_id` into the library, `status`
  (`queued` | `carded` | `skipped` | `known`), `seen_count`, `first_seen_at`, `last_seen_at`,
  `sightings` (jsonb: `{at, context, sessionId, questionId, label, asMet?}`), `surface`.
- Upsert rules (lib/vocab-queue.ts `queueVocab`): a repeat appends a sighting (deduped by
  question, else by moment + context), bumps `seen_count`, fills reading/meaning/item the first
  sighting lacked, and moves `skipped` / `known` back to `queued` (it stalled again); `carded`
  stays carded. Reading and meaning fall back to the library item when the word resolves.
- Capture points:
  - `log_attempts` → each attempt's optional `vocab_gaps: [{text, reading?, meaning?, context?}]`;
    context defaults to the attempt's note or stem; result gains `vocabQueued`.
  - MCP `queue_vocab {words, taken_at?, label?}` for words met outside a graded set; with
    `session_id` + `number` (+ `position`) it ties the words to a question already logged,
    with the same sighting an attempt's `vocab_gaps` gets. `update_attempt`'s `vocab_gaps`
    does the same while correcting the attempt.
  - (Hub form: not built; the MCP surfaces are where words come up.)
- Read / decide: MCP `get_vocab_queue {status?, limit?}` (with per-status counts) and
  `update_vocab_queue {ids, status}`; Hub `/queue` with status tabs, per-row buttons, "Export
  Anki TSV" (`/queue/export?status=queued`, Anki 2.1.55+ header lines: tab separator, HTML,
  tags column) and "Mark all carded" for after an import.
- Pure helpers live in `lib/vocab-queue-core.ts` (no path aliases, so `node --test` loads them);
  tests in `lib/vocab-queue.test.ts`.

## Backfill

`scripts/backfill-vocab-queue.mts` (`npm run db:backfill-queue`) seeds the 28 words hand-read
out of the five `anki-queue` insights (まとめ問題 1–5, 500問 p.103, 500問 Q179, 読解 短文3,
L6 examples + れんしゅう1), dated to the sessions, surface `import`. Idempotent. The insights
stay as they are (they also carry the reasoning); the instructions block now says vocab gaps
are not insights.

## Decisions

- Status is the learner's decision, never inferred from Anki or from accuracy. "Already in
  my decks" is handled by marking `known`; a bulk import of existing deck contents as `known`
  is a possible later step.
- No delete. A word that should not be there is `skipped`.
- Hindsight is unaffected; the mirror does not read this table (a later mirror could, if
  vocab stalls turn out to matter to reflect).
- `as_met` (2026-11-14): a word printed in kana (おおぜい) is queued with `text` in its kanji /
  dictionary form (大勢) so it links to the library, and `as_met` keeps the printed form.
  Kana-only recognition is the learner's stated weak point, so the card has to test it: the
  Anki export puts the effective as_met on the Front and the kanji form first on the Back
  (columns unchanged: Front, Back, Tags). **Stored on the sighting (`sightings[].asMet`), not
  a column**, same reason as the attempt fields in 06: no migration this close to the exam.
  The row's effective as_met is the most recent sighting that has one (`effectiveAsMet`);
  promoting it to a column later is a backfill of that function's result.
- Queue rows are relinked (2026-11-14): `relink_tags` / `npm run db:relink` also fills
  `item_id` on rows queued before their library item existed (21 at the time), with the
  insert-time ladder shared in `matchQueueItem`: the text (headword, alias, kana reading), then
  the stored reading, but a reading hit only when the library writes that word in kana (綺麗
  → きれい); a reading equal to a kanji item's reading is a homophone (掃く / 履く) and stays
  unlinked. Only nulls are filled; an existing link is never changed.
