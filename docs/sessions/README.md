# Session logs

A running record of working sessions on this project — the **process**: prompts, decisions,
rationale, and what was produced. As the work iterates, this is how we preserve *how* we got to
each result (not just the result).

## What's here
- **`YYYY-MM-DD_<topic>.md`** — a curated, human-readable log of a session (committed). The durable
  record: goal, chronological steps, key decisions + rationale, deliverables, open threads.
- **`raw/YYYY-MM-DD_<topic>.jsonl`** — the complete raw transcript (every prompt + tool call + output).
  **Gitignored** (`/docs/sessions/raw/`) — these are large (often 8 MB+) and would bloat git history;
  the canonical copy also lives under `~/.claude/projects/…`. If you want a raw transcript versioned,
  commit it via git-lfs or remove the `.gitignore` line deliberately.

## How to add one
Use the personal skill **`/session-log [topic]`** (lives at `~/.claude/skills/session-log/`) — it
copies the current transcript into `raw/` and writes the curated `.md`. Or ask Claude at the end of
a session: "save a session log." Best done *before* compacting, while full context is available.

## Why
Iterative work is only reproducible if the *reasoning* is captured — why an approach was chosen,
what was rejected and for what cause. Logging it makes the work reviewable and a template for the
next project.
