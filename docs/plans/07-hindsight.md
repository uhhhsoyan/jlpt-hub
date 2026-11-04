# 07 — Hindsight memory add-on (Phase A: local)

Status: Phase A built 2026-11-04 (local only). Phase B (claude.ai access) not built.

## What it is

[Hindsight](https://hindsight.vectorize.io) is Vectorize's open-source agent memory system
(MIT, [github.com/vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)). You
`retain` text; an LLM extracts facts, entities and temporal links into a graph (Postgres +
pgvector, bundled); `recall` runs hybrid retrieval (vector + BM25 + graph traversal + temporal,
then a cross-encoder reranker) and `reflect` has an agent answer a question grounded in the
bank. A web UI ("Control Plane") shows memories as a table, a timeline or a **constellation**
graph, and an entity co-occurrence graph.

Study-ledger plan 06 cut a "Hindsight sidecar" before the freeze. This is that sidecar, rebuilt
as a strictly optional add-on for two reasons: hands-on experience with the system, and a
visual graph of the patterns in the ledger (which grammar points, root causes and sessions
co-occur).

## Architecture (add-on, not a dependency)

```
Neon Postgres (ledger)  ──read-only──▶  scripts/hindsight-mirror.mts  ──retain──▶  Hindsight (Docker, local)
      ▲ only write path                        the only bridge                       │
      │                                                                              ├─ REST  :8888  (recall/reflect, read-only use)
 MCP /mcp on Vercel, Hub UI                                                          ├─ MCP   :8888/mcp/jlpt-study/  (.mcp.json → Claude Code)
                                                                                     └─ UI    :9999
```

- **Postgres is ground truth.** `insights`, `practice_sessions`, `practice_questions` are
  written only by the Hub / MCP endpoint / CSV import, exactly as before.
- **The mirror is the only bridge.** `hindsight-mirror.mts` reads those tables (never writes
  them) and retains one memory per insight and one per confirmed session. A watermark file
  (`.hindsight/mirror-state.json`, gitignored) records mirrored ids so reruns only add new rows.
- **Recall/reflect are read-only consumers.** `hindsight-ask.mts` and the Claude Code MCP
  entry query the bank. Nothing in `app/` or `lib/` imports or calls Hindsight; if the
  container is down, only the two scripts notice.
- **Phase B (not built):** expose the bank to claude.ai web by tunnelling the local API (or
  hosting it) and adding `memory_recall` / `memory_reflect` proxy tools to the Hub's `/mcp`
  route, which would forward to Hindsight and degrade to a "memory offline" result. Retain
  would still only happen through the mirror.

## Running it

Prerequisites: Docker Desktop (Apple Silicon is supported; the full image is ~3.7 GB on
arm64), `ANTHROPIC_API_KEY` and `DATABASE_URL` in `.env.local`.

```bash
npm run hindsight:up         # = bash scripts/hindsight.sh up   (also: down | logs | status)
npm run hindsight:mirror     # retain new insights/sessions; --reset wipes the bank + state; --dry-run prints the prose
npm run hindsight:ask -- recall ほど
npm run hindsight:ask -- reflect "What patterns show up across my grammar misses, and what should I drill?"
npm run hindsight:ask -- reflect --facts "..."   # also lists the memories the answer used
npm run hindsight:down
```

`scripts/hindsight.sh` holds the config at the top (ports 8888/9999, container `hindsight`,
named volume `hindsight-data` mounted at `/home/hindsight/.pg0`, bank `jlpt-study`, provider
and model). It runs the official all-in-one image `ghcr.io/vectorize-io/hindsight:latest`
with the flags from the installation docs (`--shm-size=1g --stop-timeout 75 --restart
unless-stopped`) and waits on `GET /health`.

- **UI:** http://localhost:9999 → bank `jlpt-study` (http://localhost:9999/banks/jlpt-study).
  The Memories view has a table / timeline / **constellation** toggle (the graph of memories
  and their typed links); the **Entities** tab lists extracted entities and has the
  co-occurrence graph (which entities appear together, click through to the memories).
- **API:** http://localhost:8888 (`/health`, `/v1/default/banks/jlpt-study/...`).
- **MCP for Claude Code:** `.mcp.json` entry `hindsight` → `http://localhost:8888/mcp/jlpt-study/`
  (Streamable HTTP, bank-pinned so tools need no `bank_id`). Tools include `recall`, `reflect`,
  `list_memories`, and also write tools (`retain`, `clear_memories`, `delete_bank`). Treat
  the write tools as off-limits in normal use: the mirror is the only thing that should
  retain, otherwise the bank drifts from the ledger (a `--reset` rebuild fixes drift).

## Bank and provider config

- Bank id `jlpt-study`, created/updated by the mirror with `PUT /v1/default/banks/jlpt-study`
  (`createBank` in the Node client). Its `retain_mission` and `reflect_mission` carry the
  background: one adult learner, JLPT N4 on 2026-12-06, materials (SKM N4 文法, Genki I/II,
  新にほんご500問, WaniKani, Bunpro), what the memories are (insights, graded misses with a
  root cause, lesson exposures), and the instruction to keep grammar points and root-cause
  labels verbatim as entities. Rerunning the mirror refreshes the missions.
- LLM: `HINDSIGHT_API_LLM_PROVIDER=anthropic`, `HINDSIGHT_API_LLM_API_KEY` from
  `ANTHROPIC_API_KEY` in `.env.local`, `HINDSIGHT_API_LLM_MODEL=claude-opus-5-5` (override
  with `HS_LLM_MODEL=claude-haiku-5-5 npm run hindsight:up` on a fresh container for the cheap
  option). Hindsight also documents a `claude-code` provider that uses a Claude Pro/Max
  subscription via `claude auth login` instead of an API key (`HS_LLM_PROVIDER=claude-code`);
  not used here because the API key was present.
- Embeddings and reranker: the image defaults (`local` provider, `BAAI/bge-small-en-v1.5`
  and `hindsight-ai/hs-rerank-1`, bundled, no network calls). bge-small is an English model;
  Japanese queries still work because the keyword (BM25) and graph arms match the exact
  grammar strings and the memory prose is mostly English. A multilingual alternative is
  `HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx` (`intfloat/multilingual-e5-small`), which would
  need a bank rebuild.
- Client: `@vectorize-io/hindsight-client` 1.2.0 (devDependency), `new HindsightClient({ baseUrl })`.

## What the mirror writes

- One memory per `insights` row: header line with date and source, `About:` the linked items
  (`item_ids` joined to `items` → headword, reading, kind, meaning; unlinked `items` tags by
  text), `Tags:`, then the insight text. `timestamp = created_at`, `metadata = {source:
  "insight", id}`, `document_id = insight:<id>`.
- One memory per confirmed `practice_sessions` row: label, date, closed-book practice vs
  open-book lesson, source, question count; `Missed Q{n} ({section}) on {tag headwords and
  meanings}; root cause …; note …; stem …` per miss; `Got right: …` in one line; notes
  attached to correct answers (lesson sessions carry these) in one more line.
  `timestamp = taken_at`, `metadata = {source: "session", id, mode}`, `document_id =
  session:<id>`.
- Memories are retained synchronously (`async: false`) one at a time so a failure marks only
  that row as not done. `--dry-run` prints exactly what would be sent, without touching
  Hindsight.

## Cost

Only `retain` and `reflect` call the LLM (`recall` is local: embeddings, BM25, reranker all
in the container). Retain runs one or a few extraction calls per memory, plus observation
consolidation in the background; reflect runs a small agent loop. On Opus 5.5 the first full
mirror of the ledger (16 insights + 11 sessions, ~155 questions) and a handful of reflects is
on the order of a dollar or two; incremental mirrors are a few cents per new session. Switch
`HS_LLM_MODEL` to `claude-haiku-5-5` if that matters. There is no cost while idle.

## Wipe and rebuild

```bash
npm run hindsight:mirror -- --reset     # DELETE the bank, drop .hindsight/mirror-state.json, re-mirror everything
```

To start completely fresh (new model, new embeddings): `npm run hindsight:down`, then
`docker rm hindsight && docker volume rm hindsight-data`, then `hindsight:up` and
`hindsight:mirror -- --reset`.

## Observed quality (first run, 2026-11-04)

First mirror of the live ledger: 16 insights + 11 confirmed sessions (155 questions), 0
failures, about 15 minutes wall clock on Opus 5.5 (retain is synchronous, one memory at a
time). Result: 308 memory units (`world` facts plus consolidated `observation`s) and 347
entities. A rerun retained nothing and skipped 27, as intended.

- **`recall ほど`** returned exactly the right material in the top slots: the 〜ほど〜ない
  rule from the L1 lesson, the より-vs-ほど polarity insight, the Q152 miss from 2026-09-18
  (`AはBほど高くない`, particle-cue-missed) and an extracted observation "recurring weakness
  with comparison patterns (ほう/どちら/ほど/より), three misses in the week ending
  September 18". Lower ranks drift to neighbouring まで/までに facts; Japanese-only queries
  are carried mostly by the keyword and graph arms (the embedder is English-only), which is
  fine because the memory prose is English with the grammar strings verbatim.
- **`recall までに`** led with the 2026-11-04 insight (misread 二十日までに… as "until"),
  the "if the action cannot be stretched over time it must be までに" test, the two lesson
  misses (Q4 careless, Q6 distractor-bias, Q33 misparse) and the counter-evidence that
  まで/までに were right elsewhere in the same lesson. Tail results are unrelated (ませんか,
  きょうだい) once the relevant set is exhausted.
- **`reflect "What patterns show up across my grammar misses, and what should I drill?"`**
  produced a coach-style answer grouped into four patterns with the actual question numbers
  and dates: (1) comparison patterns より/ほう/どちら/ほど from Q143/149/152 in September
  through the November より-direction flip, with a four-cell table drill; (2)
  particle-cue-missed as the most frequent root cause (熱が下がる, 電車で通う, 会社に勤める,
  なんでも vs なにも, でも vs だけ) with a "particle-first pass" drill; (3) distractor bias
  toward the lesson's new pattern on SKM れんしゅう2 (0/7), restating the learner's own
  "does this sentence need the pattern at all?" habit; (4) context-cue-missed on ところ
  aspect and でしょう. It correctly separated closed-book practice from open-book lessons and
  ended by suggesting the ところ/ながら weaknesses be re-tested closed-book because they only
  come from lessons so far. Took 43 s at budget `low`.
- Gotcha: reflect at budget `mid` hit the server's 300 s timeout (HTTP 504) with Opus 5.5
  on this bank; `hindsight-ask.mts` defaults reflect to `low` and accepts `--budget`.
- Entity extraction is reasonable but noisy: `user`, `新完全マスター`, `unclassified` (the
  root-cause placeholder) and `より` are the top entities. The `Entities` tab is where to
  prune or merge if the co-occurrence graph gets cluttered; the retain mission already asks
  for grammar points and root causes verbatim.
- Session memories for the long 500問 imports (24 questions) are chunked by Hindsight, so
  one session shows up as several `world` facts in the graph, each carrying the date.
