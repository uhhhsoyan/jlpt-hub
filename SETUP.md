# JLPT Hub — setup

Next.js 16 + Tailwind v4 + Drizzle/Neon + Claude (Anthropic API). First feature: the **Sentence Workshop** (English → JLPT N5/N4 Japanese + faithful version + level breakdown, with save/browse).

## 1. Environment

```bash
cp .env.example .env.local
```

- **`ANTHROPIC_API_KEY`** — from [console.anthropic.com](https://console.anthropic.com) → API keys. This is **API billing**, separate from any claude.ai Pro/Max subscription. Add a payment method / prepaid credits and set a spend limit while you're there. Generation uses `claude-opus-4-8`.
- **`DATABASE_URL`** — a Neon Postgres connection string. Either provision Neon through the Vercel dashboard (Storage → Create → Neon) and copy the pooled connection string, or sign up at [neon.tech](https://neon.tech). Generation works without this; **saving/browsing** needs it.

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
