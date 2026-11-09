#!/usr/bin/env bash
# Unattended run of the Hindsight mirror, for launchd (scripts/hindsight-launchd.sh).
#
# Skips quietly when the container is not up, never overlaps itself, and appends a
# timestamped line per run to .hindsight/mirror.log (kept to the last 2000 lines).
# Manual equivalent: npm run hindsight:mirror
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

cd "$(dirname "$0")/.."
mkdir -p .hindsight
LOG=.hindsight/mirror.log
LOCK=.hindsight/mirror.lock
API="${HINDSIGHT_URL:-http://127.0.0.1:8888}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  log "skip: previous run still holds $LOCK"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

if ! curl -fsS -m 10 "$API/health" >/dev/null 2>&1; then
  log "skip: hindsight API not healthy at $API"
  exit 0
fi

start=$(date +%s)
out=$(node --env-file=.env.local --import tsx scripts/hindsight-mirror.mts 2>&1)
rc=$?
summary=$(printf '%s\n' "$out" | grep -E 'mirrored:|failed' | tail -1)
[ -n "$summary" ] || summary=$(printf '%s\n' "$out" | tail -1)
log "rc=$rc $(( $(date +%s) - start ))s: ${summary:-no output}"
if [ "$rc" -ne 0 ]; then
  printf '%s\n' "$out" | tail -20 | sed 's/^/    /' >> "$LOG"
fi

# Keep the log bounded.
if [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -n 1500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit 0
