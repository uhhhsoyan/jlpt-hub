# Feature plans (planning session 2026-07-17)

Three plans, intended to be executed as separate work sessions. Recommended order:

1. **[01 — Reference library](./01-reference-library.md)** — ingest the JLPT N4/N5 vocab +
   kanji lists into the DB and give them a browsable UI. Small, foundational: every other
   plan consumes this dataset.
2. **[02 — Knowledge graph / progress brain](./02-knowledge-graph.md)** — items + edges +
   evidence + mastery model; the practice-problem photo-grading loop; WaniKani sync;
   readiness dashboard. Phased (2a–2d), each phase shippable alone.
3. **[03 — Vocab sprint](./03-vocab-sprint.md)** — brute-force chunked listen/recall trainer
   adapted from the Mikel | Hyperpolyglot method. Depends on 01 (word list), benefits from
   the workshop v1.5 validation loop and feeds results into 02.

Shared context lives in `../../../research/2026-07-10-jlpt-n4-tooling-research.md`
(exam logistics, TTS ranking, level-validation technique, progress-API survey) and the
sibling `anki-tools` project (TTS + Anki push + tokenization pipelines).

> Reminder for implementing sessions: per `AGENTS.md`, read the relevant guide in
> `node_modules/next/dist/docs/` before writing code — this Next.js version has breaking
> changes vs. training data.
