# JLPT Hub — setup

Next.js 16 + Tailwind v4 + Drizzle/Neon + Claude (Anthropic API). First feature: the **Sentence Workshop** (English → JLPT N5/N4 Japanese + faithful version + level breakdown, with save/browse).

## 1. Environment

Secrets live in the Vercel project (`jlpt-hub`) and are pulled into `.env.local`; nothing is hand-edited.

```bash
npm i -g vercel && vercel login          # once
vercel link --yes --project jlpt-hub     # once per clone
npm run env:pull                         # writes .env.local from the Development environment
```

To add or change a value, store it on Vercel as a plain (pullable) variable in all three environments, then pull again. The script prompts for the value with hidden input so you can paste it from a browser without opening an editor:

```bash
npm run env:set -- DATABASE_URL ANTHROPIC_API_KEY      # prompts per name
npm run env:set -- CRON_SECRET=$(openssl rand -hex 32) # inline value
npm run env:pull
```

Values that were stored as **Sensitive** on Vercel can never be read back by `env:pull` (they come down as empty strings). `env:set` replaces such a variable with a plain one, so re-enter the value from its source:

- **`DATABASE_URL`** — Neon pooled connection string: [console.neon.tech](https://console.neon.tech) → project → Connect, or Vercel → Storage → the Neon database → `.env.local` tab. Generation works without this; **saving/browsing** needs it.
- **`ANTHROPIC_API_KEY`** — [console.anthropic.com](https://console.anthropic.com) → API keys (existing keys can't be viewed; create a new one). This is **API billing**, separate from any claude.ai Pro/Max subscription. Add a payment method / prepaid credits and set a spend limit while you're there. Generation uses `claude-opus-4-8`.
- **`BLOB_READ_WRITE_TOKEN`** *(optional locally)* — Vercel → Storage → the Blob store → `.env.local` tab.
- **`WANIKANI_TOKEN`** *(optional)* — [wanikani.com/settings/personal_access_tokens](https://www.wanikani.com/settings/personal_access_tokens).
- **`BUNPRO_API_KEY`** *(optional)* — from [bunpro.jp/settings/api](https://bunpro.jp/settings/api), enables the read-only Bunpro grammar sync (see `docs/plans/05-bunpro-sync.md`).
- **`MCP_TOKEN`** — see "Study ledger (MCP)" below. **`CRON_SECRET`** — any random string, only used by Vercel Cron.
- **`WHISPER_MODEL` / `WHISPER_CLI`** — local only (Listening Mine); `env:pull` overwrites `.env.local`, so put these in `.env.development.local` instead.

`.env.example` documents every variable.

## 2. Database

Once `DATABASE_URL` is set, create the table:

```bash
npm run db:push       # applies lib/db/schema.ts to the database
# npm run db:studio   # optional: browse the data
```

## 3. Run

```bash
npm run dev           # http://localhost:3000
```

You can generate sentences as soon as the API key is set. Saving lights up once the DB is connected.

## 4. Checks

```bash
npx tsc --noEmit      # typecheck
npm run lint          # eslint
```

## Notes / next steps

- **Auth:** the generate endpoint spends API credits, so before deploying, gate the app (Vercel project → Settings → Deployment Protection → Password, or an app-level login). It's unprotected locally.
- **v1.5 — vocabulary validation loop:** tokenize the N4 output (kuromoji/Sudachi) and check every word against an N4 vocab list, re-prompting on out-of-range words. Prompting alone doesn't perfectly hold the level; this makes it rigorous. Grammar-level tags stay best-effort.
- **Later:** WaniKani progress panel (server-side token pull), and an export bridge from saved sentences into the `anki-tools` pipeline (audio + Anki cards).

## Listening Mine (local only)

The **Mine** tab pulls sentence-level audio clips out of a YouTube video (yt-dlp → Whisper → ffmpeg). These binaries can't run on Vercel, so this feature only works when you run the app locally.

One-time setup:

```bash
brew install yt-dlp ffmpeg whisper-cpp        # if not already installed
# Download a Japanese-capable ggml model, e.g. large-v3-turbo (~1.5 GB):
mkdir -p ~/models && cd ~/models
curl -L -o ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Then in `.env.local`:

```
WHISPER_MODEL=/Users/<you>/models/ggml-large-v3-turbo.bin
# WHISPER_CLI=whisper-cli   # only if the binary isn't named whisper-cli
```

Also run `npm run db:push` once so the `clips` table exists. Clips are written to `public/mined/` (gitignored) and served locally. A full video takes a couple of minutes to transcribe. For higher Japanese accuracy, a kotoba-whisper ggml model can be dropped in later — just point `WHISPER_MODEL` at it.

## Deploy (when ready)

```bash
npx vercel            # link + deploy; set env vars in the Vercel dashboard
```

## Study ledger (MCP)

The Hub exposes its study ledger as an MCP server at `/mcp` (Streamable HTTP, stateless,
JSON responses) so Claude can log reviewed practice pages from anywhere — the claude.ai
project, Claude Code, the mobile app — instead of appending to a CSV. Tools:
`log_attempts` (with `mode` practice|lesson), `log_insight`, `get_insights`, `find_items`,
`relink_tags`, `get_weakness_report`, `get_readiness`, `list_sessions`, `sync_status`.
Source: `app/mcp/route.ts`, write path in `lib/ledger.ts`, tag matching in `lib/item-match.ts`.

1. **Token.** `npm run env:set -- MCP_TOKEN=$(openssl rand -hex 32)` then `npm run env:pull`.
   The endpoint refuses everything while the var is unset.
2. **Schema.** `npm run db:push` adds `practice_sessions.surface/timed/mode`,
   `practice_questions.level/root_cause/note/meta`, `items.aliases`, and the `insights`
   table. Then `npm run db:seed` (aliases and hand-curated items live in
   `data/seed/grammar.json` / `vocab-extra.json`) and `npm run db:relink` to attach any
   tags that were logged before their item or alias existed.
3. **claude.ai** (web, desktop, mobile share one connector): Settings → Connectors → Add
   custom connector → URL `https://<host>/mcp`. Authentication: choose **No sign-in** (the
   form may say it "detected" sign-in; ignore that). Add one request header: name
   `x-api-key`, value the bare token (no "Bearer" prefix); the form reserves the
   `Authorization` header for its own OAuth flow, which is why the endpoint accepts the
   token either way. Then enable it in the Japanese Study project.
4. **Claude Code:** `.mcp.json` at the repo root already points at production and reads the
   token from `$MCP_TOKEN` in your shell (`export MCP_TOKEN=…`). Or:
   `claude mcp add --transport http study-ledger https://<host>/mcp --header "Authorization: Bearer <token>"`.
5. **Smoke test** (replace host/token):
   ```bash
   curl -s -X POST https://<host>/mcp -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' -H "Authorization: Bearer $MCP_TOKEN" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sync_status","arguments":{}}}'
   ```

Sessions logged through MCP land as `confirmed` (the review happened in the conversation
that logged them). `mode=lesson` marks open-book work (textbook examples, れんしゅう right
after the explanation): it is stored as `exposure` evidence and excluded from accuracy, the
weak list and the root-cause panel, so only closed-book `practice` moves those. Every
practice miss should carry a `root_cause` (`ROOT_CAUSES` in `lib/types.ts` is the preferred
list; any kebab-case label is kept) because the "Why you miss" panel on `/progress` groups
on it. Tags that match no item are kept with the question; add the item or an alias to the
seed data, re-seed, and run `npm run db:relink` (or the `relink_tags` tool).

**Importing the old CSV ledger.** Download `jlpt_500_ledger.csv` from the claude.ai project
files into `data/import/` (gitignored) and run `npm run db:import-ledger`. It creates one
confirmed session per date, links each `grammar_point` label to library items, writes Genki
refs onto matched grammar items, and prints anything it could not match. Re-running replaces
the previous import.

Labels are free text ("借りた vs 貸した", "kanji-reading:大人(おとな)"), so anything that is not
an exact headword is mapped to 1–3 items by Claude (needs `ANTHROPIC_API_KEY`; about 30k
input tokens, cached across batches). Answers land in `data/import/ledger-tags.json`; edit
an entry to correct a link, delete it to re-map, or pass `--no-claude` to use the cache only.

Deployment Protection must stay **off** for `/mcp` (claude.ai cannot pass a Vercel
password); the bearer token is the gate. Production currently has it off.
