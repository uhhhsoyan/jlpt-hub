#!/usr/bin/env bash
# Store env vars on Vercel as PLAIN (pullable) values in development, preview and production.
#
#   npm run env:set -- DATABASE_URL ANTHROPIC_API_KEY     # prompts (hidden) for each value; paste + Enter
#   npm run env:set -- CRON_SECRET=$(openssl rand -hex 32) # value given inline
#
# Replaces any existing copy, including "sensitive" ones that `vercel env pull` can't read back.
# Afterwards: npm run env:pull
set -euo pipefail

ENVS=(development preview production)
[ $# -gt 0 ] || { echo "usage: npm run env:set -- NAME [NAME=value ...]" >&2; exit 1; }

for ARG in "$@"; do
  if [[ "$ARG" == *=* ]]; then
    NAME="${ARG%%=*}"; VAL="${ARG#*=}"
  else
    NAME="$ARG"
    printf 'Value for %s (paste, Enter; input is hidden): ' "$NAME" >&2
    IFS= read -rs VAL; echo >&2
  fi
  if [ -z "$VAL" ]; then echo "  empty value, skipping $NAME" >&2; continue; fi
  for E in "${ENVS[@]}"; do
    vercel env rm "$NAME" "$E" --yes >/dev/null 2>&1 || true
    printf '%s' "$VAL" | vercel env add "$NAME" "$E" >/dev/null
  done
  echo "  $NAME set in: ${ENVS[*]}" >&2
done
echo "Done. Pull them locally with: npm run env:pull" >&2
