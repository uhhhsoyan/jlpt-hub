# WaniKani sync — manual verification checklist

There's no test framework in this repo yet, so verify `lib/wanikani.ts` by hand once
a token and a seeded database are available. Nothing here runs automatically.

## Prerequisites

1. `WANIKANI_TOKEN` set in `.env.local` — generate one at
   https://www.wanikani.com/settings/personal_access_tokens (read-only scope is enough).
2. `DATABASE_URL` set and `npm run db:push` + `npm run db:seed` already run, so `items`
   has real N4 vocab/kanji rows to match against.
3. Wire up the call site (not part of this change): call `runWanikaniSync()` from
   `app/progress/actions.ts`, e.g. via the `WanikaniSyncButton` on a `/progress` page.

## What to run

- Click "Sync WaniKani" once, or call `runWanikaniSync()` directly from a scratch script.
- Click it a second time immediately after. This is the important check: a second sync
  with no new WK activity should be idempotent —
  - `newlyMapped` should drop to (or near) 0 (mapping is stable, only new items map).
  - `observationsWritten` should land on the same count as the first run (delete +
    reinsert of the same snapshot), not double.
  - `unmatchedSubjects` should stay the same both times.

## Expected counts (sanity ranges, not exact)

- `subjectsFetched`: a few thousand — WaniKani has ~2,000 kanji + ~9,000 vocab across
  all 60 levels combined (kanji + vocabulary + kana_vocabulary, hidden excluded).
- `itemsMapped`: bounded by how many N4-list items exist in `items` (kind='kanji' or
  'vocab') — likely a few hundred, since our library only covers N5/N4, a small slice
  of WK's full range.
- `unmatchedSubjects`: subjectsFetched - itemsMapped, roughly — expected to be large
  (most WK subjects are N3-N1 vocab/kanji not in this library), not a bug.
- `assignmentsSeen`: however many subjects the WK account has actually started
  (assignments only exist once a subject enters a user's SRS queue).
- `observationsWritten`: <= assignmentsSeen, and <= itemsMapped — only assignments
  that (a) have started (`srs_stage` not null) and (b) map to a library item count.

## Things that would indicate a bug, not just "not much overlap"

- `itemsMapped` is 0 despite `subjectsFetched` being in the thousands — headword/reading
  matching is broken (check `items.reading` actually holds hiragana matching WK's
  reading strings, not romaji).
- Re-running the sync keeps growing `observationsWritten` — the delete-before-insert
  step isn't running (check the `DELETE ... WHERE source = 'wanikani'` executes before
  the insert, not after, and isn't silently failing).
- `items.detail` loses existing keys (e.g. `pos`, `onyomi`) after a sync — the jsonb
  merge regressed to an overwrite; re-check the `coalesce(detail,'{}'::jsonb) || jsonb_build_object(...)`
  SQL in `persistMapping`.

## Manual error-path checks

- Unset `WANIKANI_TOKEN` → expect `{ok:false}` naming the env var and the WaniKani
  token settings URL.
- Set `WANIKANI_TOKEN` to garbage → expect the 401 message about an invalid token.
- Unset `DATABASE_URL` → expect the "Database not configured" message, not a raw
  stack trace surfaced to the button.
