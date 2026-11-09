# 07 — Hindsight memory add-on (Phase A: local)

Status: Phase A built 2026-11-04 (local only). Phase B (remote access through Cloudflare, memory
tools in the Hub) code built 2026-11-05; the Cloudflare side is a one-time manual setup (checklist
below).

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
- **Phase B (built, see below):** the local API and UI are published through a Cloudflare
  Tunnel behind Cloudflare Access, and the Hub's `/mcp` route gained `memory_recall` /
  `memory_reflect` proxy tools (`lib/hindsight.ts`) that forward to Hindsight and degrade to a
  status (`offline` / `unconfigured` / `rejected`) instead of failing. Retain still only
  happens through the mirror.

## Running it

Prerequisites: Docker Desktop (Apple Silicon is supported; the full image is ~3.7 GB on
arm64), `ANTHROPIC_API_KEY` and `DATABASE_URL` in `.env.local`.

```bash
npm run hindsight:up         # = bash scripts/hindsight.sh up   (also: down | recreate | logs | status)
npm run hindsight:mirror     # retain new insights/sessions; --reset wipes the bank + state; --dry-run prints the prose
npm run hindsight:ask -- recall ほど
npm run hindsight:ask -- reflect "What patterns show up across my grammar misses, and what should I drill?"
npm run hindsight:ask -- reflect --facts "..."   # also lists the memories the answer used
npm run hindsight:down
```

`scripts/hindsight.sh` holds the config at the top (ports 8888/9999 bound to **127.0.0.1
only**, container `hindsight`, named volume `hindsight-data` mounted at `/home/hindsight/.pg0`,
bank `jlpt-study`, provider and model). It runs the official all-in-one image
`ghcr.io/vectorize-io/hindsight:latest` with the flags from the installation docs
(`--shm-size=1g --stop-timeout 75 --restart unless-stopped`) and waits on `GET /health`.

Auth (since 2026-11-05): with `HINDSIGHT_API_KEY` in `.env.local` the container starts with
Hindsight's built-in single-tenant API-key extension
(`HINDSIGHT_API_TENANT_EXTENSION=…:ApiKeyTenantExtension`), so REST and MCP require
`Authorization: Bearer <key>`; the UI's server side gets the same key
(`HINDSIGHT_CP_DATAPLANE_API_KEY`). `HINDSIGHT_UI_ACCESS_KEY` sets the UI login
(`HINDSIGHT_CP_ACCESS_KEY`); without it the UI has no login. The mirror, `hindsight:ask` and
`.mcp.json` all send `HINDSIGHT_API_KEY`. Docker only applies env/port changes to a new
container: `bash scripts/hindsight.sh recreate` drops the container and keeps the volume.
Only `/health` is unauthenticated.

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
  `ANTHROPIC_API_KEY` in `.env.local`, `HINDSIGHT_API_LLM_MODEL=claude-haiku-5-5` (default
  since 2026-11-09; the first mirrors ran on `claude-opus-5-5`; override with
  `HS_LLM_MODEL=claude-sonnet-5-5 bash scripts/hindsight.sh recreate` for better reflect
  answers). Only retain and reflect use the LLM; recall is local. Hindsight also documents a `claude-code` provider that uses a Claude Pro/Max
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
- The watermark lives in the checkout that ran the mirror (`.hindsight/` is gitignored). A
  mirror from a fresh checkout or worktree re-retains everything; Hindsight replaces memories
  by `document_id`, so the bank does not duplicate, but it costs a full extraction pass
  (observed 2026-11-05: 71 memories re-retained from the main checkout after the Phase A
  worktree, where the state file was, had been removed).

## Cost

Only `retain` and `reflect` call the LLM (`recall` is local: embeddings, BM25, reranker all
in the container). Retain runs one or a few extraction calls per memory, plus observation
consolidation in the background; reflect runs a small agent loop. On Opus 5.5 the first full
mirror of the ledger (16 insights + 11 sessions, ~155 questions) and a handful of reflects is
on the order of a dollar or two; incremental mirrors are a few cents per new session. Since
2026-11-09 the default is `claude-haiku-5-5` (roughly a tenth of that); switch `HS_LLM_MODEL`
back up if reflect answers get too thin. There is no cost while idle.

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

## Phase B — remote access and Hub memory tools

Goal: see the graphs from any of my machines and let claude.ai (through the Hub's `/mcp`)
recall from the bank, without opening a port on the M2 and without the M2 becoming a way in.

```
browser (any device) ──Google/OTP login──▶ Cloudflare Access ──▶ hindsight.uhhhsoyan.com      ─┐
                                                                                            ├─ Cloudflare Tunnel ──▶ cloudflared on M2 (outbound only) ──▶ 127.0.0.1:9999 (UI, own login)
Vercel /mcp memory_* ──service token─────▶ Cloudflare Access ──▶ hindsight-api.uhhhsoyan.com  ─┘                                                        └──▶ 127.0.0.1:8888 (API, bearer key)
```

Layers, outermost first: Cloudflare Access (identity or service token; nothing reaches the
tunnel without it) → cloudflared forwards only to the two loopback ports → Hindsight's own
API key (REST, MCP) and UI access key. The M2 itself stays reachable only over Tailscale SSH.

### What a breach of each layer gets

- Access bypassed / service token leaked: read the bank (my study history), run reflect on
  my Anthropic key (cost), and, through the API's write endpoints, wipe or pollute the bank.
  The bank is rebuilt from Postgres by `hindsight:mirror -- --reset`; the ledger is untouched.
  Mitigation: a separate Anthropic key with a spend limit for the container, rotate the
  service token from the Zero Trust dashboard (and `npm run env:set`), rotate
  `HINDSIGHT_API_KEY` with `recreate`.
- cloudflared compromised: it is a user-space process forwarding to two loopback ports; it
  has no shell, no credentials beyond the tunnel token, and the Tailscale/SSH surface is
  unchanged.
- Hindsight 0-day: same blast radius as the first bullet; the container has only the
  Anthropic key and the bank.

### One-time setup (Cloudflare side, dashboard)

Prerequisite: a domain whose DNS is on Cloudflare (free plan is fine). Names below assume
`hindsight.uhhhsoyan.com` for the UI and `hindsight-api.uhhhsoyan.com` for the API.

1. **Tunnel.** Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → name
   `essoyan-m2`. The dashboard shows a macOS install command; cloudflared is already
   installed by Homebrew (`brew install cloudflared`, 2026-11-05), so run only the service
   line on the M2 — it contains the tunnel token:
   `sudo cloudflared service install <token>` (LaunchDaemon, survives logout; without sudo it
   installs a per-user LaunchAgent, fine for an always-logged-in clamshell Mac).
   Check: `sudo launchctl list | grep cloudflare` and the tunnel shows **Healthy** in the
   dashboard.
2. **Public hostnames** (tunnel → Public Hostname tab → Add): `hindsight.uhhhsoyan.com` → service
   `HTTP` `localhost:9999`; `hindsight-api.uhhhsoyan.com` → `HTTP` `localhost:8888`. Cloudflare
   creates the DNS records. Do not add anything else.
3. **Service token.** Zero Trust → Access → Service Auth → Service Tokens → Create
   `jlpt-hub-vercel` (duration: 1 year or non-expiring). Copy the Client ID and Client Secret
   now; the secret is shown once.
4. **Access application.** Zero Trust → Access → Applications → Add → Self-hosted → name
   `Hindsight`, add both hostnames, session duration 1 week. Policies:
   - `owner`: action **Allow**, include **Emails** = my address. Identity: the default
     One-time PIN is enough; add Google if preferred.
   - `hub`: action **Service Auth**, include **Service Token** = `jlpt-hub-vercel`.
   Leave everything else default (no bypass rules).
5. **Vercel env** (from the repo, `vercel` CLI logged in; sets development, preview and
   production, then `npm run env:pull` to refresh `.env.local`):

   ```bash
   npm run env:set -- HINDSIGHT_URL=https://hindsight-api.uhhhsoyan.com HINDSIGHT_UI_URL=https://hindsight.uhhhsoyan.com
   npm run env:set -- HINDSIGHT_API_KEY HINDSIGHT_UI_ACCESS_KEY   # paste the values from .env.local (hidden prompt)
   npm run env:set -- CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET  # paste from step 3
   ```

   `HINDSIGHT_UI_ACCESS_KEY` is not used by the Hub; storing it keeps `npm run env:pull`
   from dropping it out of `.env.local`. Redeploy (merge or `vercel --prod`).

### Verify

```bash
# From anywhere. Without Access credentials: a 302 to the Cloudflare login (UI) / 403 (API).
curl -sI https://hindsight-api.uhhhsoyan.com/health | head -1
# With the service token: 200, then Hindsight's own auth.
curl -s -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" https://hindsight-api.uhhhsoyan.com/health
curl -s -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..." https://hindsight-api.uhhhsoyan.com/v1/default/banks   # 401 without the bearer key, 200 with
# From the Hub (needs the MCP_TOKEN): sync_status.memory.configured true, then a recall.
```

Browser: `https://hindsight.uhhhsoyan.com/banks/jlpt-study` → Cloudflare login → Hindsight login
(`HINDSIGHT_UI_ACCESS_KEY`) → the bank. The Progress page shows a "Memory graph" card with
this link when `HINDSIGHT_UI_URL` is set.

### Hub side (built 2026-11-05)

- `lib/hindsight.ts`: `readHindsightConfig` (null without `HINDSIGHT_URL`), `memoryRecall`,
  `memoryReflect` via `@vectorize-io/hindsight-client` with `apiKey` plus the
  `CF-Access-Client-Id/Secret` headers; client-side timeouts (recall 20 s, reflect 50 s under
  the route's `maxDuration = 60`); `classifyFailure` maps 401/403 and an HTML login page to
  `rejected` (our config is wrong), everything else (5xx incl. Cloudflare 530 "tunnel down",
  timeouts, connection refused) to `offline`. Unit tests in `lib/hindsight.test.ts`.
- `app/mcp/route.ts` (server version 1.4.0, 14 tools): `memory_recall {query, budget?, limit?}`
  → `{status:'ok', hits:[{text,type,when,documentId,entities}], count}`; `memory_reflect
  {question, budget? low|mid}` → `{status:'ok', text, basedOn}`; both return the non-ok
  statuses as data so claude.ai carries on with the ledger tools. `sync_status` gained
  `memory: {configured, bank, accessToken, apiKey}`.
- `app/progress/memory-link.tsx`: the graph link card (server-rendered, hidden when
  unconfigured).
- Smoke 2026-11-05 against the local container through the dev server: recall `ほど` → 3
  hits with `session:`/`insight:` ids; reflect "which two grammar points do I confuse most"
  → grounded answer (comparisons より/ほど/のほうが with the five logged slips; 〜ながら with
  four) in 40 s, `basedOn` 20 memories.

### Operations

- The mirror runs on a schedule (since 2026-11-09): `npm run hindsight:schedule` installs a
  per-user LaunchAgent `com.jlpt-hub.hindsight-mirror` (`scripts/hindsight-launchd.sh`) that
  runs `scripts/hindsight-mirror-job.sh` at 02:15, 08:15, 14:15 and 20:15 local. The job
  skips when the container is down, never overlaps itself, and appends one line per run to
  `.hindsight/mirror.log` (`npm run hindsight:schedule-status` shows the last ones). A run
  with nothing new only queries Postgres, so it costs nothing. `npm run hindsight:mirror`
  still works by hand for an immediate refresh; the bank lags the ledger by at most six
  hours otherwise, and the tool descriptions say so.
- Cloudflare's free tier limits one request to 100 s at the origin; reflect at budget `mid`
  (observed up to 300 s) will not fit, so the Hub only offers `low` and `mid`, defaults to
  `low`, and reports a timeout as `offline`.
- SSH fallback for the UI when the tunnel is down: `ssh -L 9999:127.0.0.1:9999 essoyan-m2-max`
  then http://localhost:9999 (the UI login still applies).
- Cost: Cloudflare Tunnel and Access are free for this use (Zero Trust free plan, up to 50
  users); the domain is the only fee.
