# Plan 03 — Vocab sprint (adapted from the Mikel | Hyperpolyglot method)

## The video, actually summarized

"Learn 2000 Words in 7 Days and Understand 90% of Any Language" — Mikel | Hyperpolyglot,
youtube.com/watch?v=etywD4c7S6U (~18 min; full transcript pulled 2026-07-17). His method:

1. **A frequency-sorted spreadsheet of ~2,000 verbs** (verbs specifically — "the verb
   determines what the sentence is about"), each with an example sentence, plus English
   translations of both. Zipf's-law argument: the first half of the list ≈ 80% comprehension.
   Sentences multiply the yield — 2,000 verbs ≈ 3–4k words learned in context.
2. **Audio files of every example sentence, target-language only.** Listen on repeat all
   day (commute, gym) — ~2h of audio, ~10 full passes in a week. Repetition over everything.
3. **Two study passes, in ~100-word chunks:**
   - Pass 1 (comprehension): read along while listening, glancing at the English meaning.
   - Pass 2 (**active recall**): hide the target language, read the English, try to say the
     sentence aloud, check, move on fast. "Most of it you'll get wrong. It doesn't matter."
   - Alternate passes over the whole list, repeatedly. Spreadsheet over Anki because it's
     faster; speed is a feature.
4. **Mnemonics** if the language isn't cognate with one you know (he skipped them for
   French-from-Spanish; explicitly says Russian/Arabic learners need them — Japanese too).
5. **The "sandwich"**: once the sentence audio feels easy, alternate every ~5 minutes
   between it (comfort zone) and real native podcasts (hard), stretching intervals as
   comprehension grows. Optionally speed sentence audio to 1.25–1.5× so native speech
   feels slower by contrast.

## Honest evaluation

**The headline is oversold; the machinery is sound.** "2,000 words in 7 days" means
*recognition-level familiarity* after implied 10+ hrs/day, self-graded, with no spacing
beyond one week — not durable production vocabulary. And Japanese is harder than his
French-from-Spanish case in exactly the ways he waves at: zero cognates (mnemonics
required) plus a kanji/reading layer French doesn't have.

But every component is legitimate and evidence-aligned: frequency ordering, sentence-context
learning, active recall aloud, massive passive re-listening, and easy↔hard interleaving.
The sandwich is precisely the "level cliff" bridge the July 10 research doc identified as
the biggest gap in N4 listening tools — and this app already has both halves: generated
level-controlled sentences (workshop) and real native audio slices (listening mine).

Two Japanese-specific adaptations:
- **The list is already defined**: N5+N4 vocab (~1,500 items from Plan 01), not 2,000
  generic verbs — the JLPT list *is* the frequency cut that matters for Dec 6. Verbs-first
  ordering within it is still a good idea (nihongoichiban's N4 verb list gives POS tags).
- **Recall grading can feed the knowledge graph** (Plan 02) instead of evaporating like his
  spreadsheet self-checks.

## What to build: `/sprint`

### Data prep (batch, offline-ish)

1. For each vocab item without one, generate **one example sentence** constrained to
   N4-and-below, via the existing workshop Claude pipeline — but gated by the **workshop
   v1.5 validation loop** (tokenize → lemma-match against the items table → re-prompt on
   violations; prompting alone provably doesn't hold level, per research doc / arXiv
   2506.04072). Store per item: sentence, kana reading, English. New table `sprintSentences`
   (itemId, japanese, reading, english, audioUrl) or fold into `items.detail`— prefer the
   table; sentences may be regenerated.
2. **TTS every sentence.** Per the research doc's ranking: Google Chirp 3 HD ja-JP
   (1M free chars/month → effectively $0; ~1,500 short sentences is trivial), fallback
   VOICEVOX locally. Feed **kana** to TTS to dodge kanji misreadings (行った problem).
   Files → Vercel Blob (prod) or `public/sprint/` (local), mirroring the clips pattern.
   This replaces/upgrades the macOS `say` Kyoko approach from anki-tools.
3. Ordering: chunk into **decks of 100** — verbs first, then the rest; within a group keep
   list order (open decision: join a real frequency rank, e.g. jpdb/BCCWJ, later — don't
   block v1 on it).

### Modes (per chunk of 100)

1. **Listen** — gapless playlist player: loop, shuffle toggle, speed 1.0/1.25/1.5×
   (browser `playbackRate`, pitch-preserving), Japanese audio only, lock-screen friendly.
   The point is dozens of passive passes.
2. **Read-along** — sentence list with reading + English, audio per row; tap-to-play.
   (Pass 1 of his method.)
3. **Recall** — the core: show English → user says the Japanese aloud → reveal (Japanese +
   reading + replay audio) → self-grade got-it / missed-it, keyboard-driven, fast. Each
   grade writes a `sprint` answer observation to the knowledge graph. No typing/STT in v1 —
   his speed argument is right, and self-grading is honest enough when the data is only
   steering study focus. (STT scoring via kotoba-whisper is a possible v2, flagged
   non-essential in the research doc.)
4. **Sandwich** — alternating timer: N minutes of sprint playlist ↔ N minutes of a
   listening-mine clip queue (real native audio already in the `clips` table), with a
   "too hard, back to easy" escape key. Start at 5-min intervals per the video.

### Progress

Per-chunk state (listens completed, last recall accuracy) + overall "words touched /
words solid" tying into `itemMastery`. A sprint week against a 100-word chunk should
visibly move the Plan 02 dashboard — that's the motivating loop.

## Dependencies / order

Needs Plan 01 (the word list). Wants the workshop v1.5 validation loop (SETUP.md) built
first — sprint sentence generation is its first bulk consumer. Observations land in Plan
02's tables if they exist, else buffer in a local table and backfill (don't block on 02).

## Open decisions

- TTS voice/provider final pick (Chirp 3 HD default; audition VOICEVOX/AivisSpeech for pitch-accent quality).
- Frequency rank source for ordering beyond verbs-first.
- Whether Listen mode needs an offline/PWA story for the gym-and-commute use case (v1: no —
  a phone browser tab is fine; revisit if it annoys).

## Verification

- Generate + validate + TTS one 100-word chunk end-to-end; listen for misreadings on 20
  random sentences (kana-fed TTS should prevent them).
- Recall mode: 20-word session writes 20 observations with correct item links.
- Playlist survives screen-lock on iOS Safari (known finicky) — test before calling done.
