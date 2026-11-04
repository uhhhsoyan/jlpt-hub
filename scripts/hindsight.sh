#!/usr/bin/env bash
# Run the Hindsight memory server locally (optional add-on; see docs/plans/07-hindsight.md).
#
# Usage: bash scripts/hindsight.sh up|down|logs|status
#
# Hindsight is Vectorize's open-source agent memory (https://hindsight.vectorize.io). This
# runs the official all-in-one image (API + web UI + embedded Postgres) in Docker. The
# Postgres ledger stays the only source of truth; scripts/hindsight-mirror.mts copies it in.
set -euo pipefail

# ---- config -------------------------------------------------------------------------
HS_CONTAINER="${HS_CONTAINER:-hindsight}"
HS_IMAGE="${HS_IMAGE:-ghcr.io/vectorize-io/hindsight:latest}"
HS_VOLUME="${HS_VOLUME:-hindsight-data}"          # named volume for the embedded Postgres
HS_API_PORT="${HS_API_PORT:-8888}"                # REST + MCP
HS_UI_PORT="${HS_UI_PORT:-9999}"                  # Control Plane (web UI)
HS_BANK="${HS_BANK:-jlpt-study}"                  # bank id used by mirror/ask and .mcp.json
HS_LLM_PROVIDER="${HS_LLM_PROVIDER:-anthropic}"   # anthropic | claude-code | openai | ...
HS_LLM_MODEL="${HS_LLM_MODEL:-claude-opus-5-5}"   # claude-haiku-5-5 is the cheap option
HS_ENV_FILE="${HS_ENV_FILE:-.env.local}"          # where ANTHROPIC_API_KEY lives
# -------------------------------------------------------------------------------------

cd "$(dirname "$0")/.."

api_url="http://localhost:${HS_API_PORT}"

read_env() {
  # Print the value of $1 from the env file without echoing anything else.
  [ -f "$HS_ENV_FILE" ] || return 0
  grep -E "^$1=" "$HS_ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

health() {
  curl -fsS "${api_url}/health" >/dev/null 2>&1
}

up() {
  if docker ps --format '{{.Names}}' | grep -qx "$HS_CONTAINER"; then
    echo "hindsight: already running"; status; return
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$HS_CONTAINER"; then
    echo "hindsight: starting existing container"
    docker start "$HS_CONTAINER" >/dev/null
  else
    local key=""
    case "$HS_LLM_PROVIDER" in
      anthropic) key="${ANTHROPIC_API_KEY:-$(read_env ANTHROPIC_API_KEY)}"
                 [ -n "$key" ] || { echo "ANTHROPIC_API_KEY missing (shell or $HS_ENV_FILE)"; exit 1; } ;;
      claude-code) key="${HS_LLM_API_KEY:-}" ;;   # optional: output of `claude setup-token`
      *) key="${HS_LLM_API_KEY:-}" ;;
    esac
    echo "hindsight: creating container ($HS_IMAGE, provider=$HS_LLM_PROVIDER, model=$HS_LLM_MODEL)"
    # Flags per https://hindsight.vectorize.io/developer/installation (Docker section).
    docker run -d --name "$HS_CONTAINER" --restart unless-stopped \
      --shm-size=1g --stop-timeout 75 \
      -p "${HS_API_PORT}:8888" -p "${HS_UI_PORT}:9999" \
      -e HINDSIGHT_API_LLM_PROVIDER="$HS_LLM_PROVIDER" \
      -e HINDSIGHT_API_LLM_API_KEY="$key" \
      -e HINDSIGHT_API_LLM_MODEL="$HS_LLM_MODEL" \
      -e HINDSIGHT_API_WORKER_ID=jlpt-hub-local \
      -v "${HS_VOLUME}:/home/hindsight/.pg0" \
      "$HS_IMAGE" >/dev/null
  fi
  echo -n "hindsight: waiting for ${api_url}/health "
  for _ in $(seq 1 120); do
    if health; then echo "ok"; status; return; fi
    echo -n "."; sleep 2
  done
  echo; echo "hindsight: API did not become healthy; see: bash scripts/hindsight.sh logs"; exit 1
}

down() {
  docker stop "$HS_CONTAINER" >/dev/null 2>&1 && echo "hindsight: stopped" || echo "hindsight: not running"
}

logs() {
  docker logs -f --tail 200 "$HS_CONTAINER"
}

status() {
  local state
  state=$(docker inspect -f '{{.State.Status}}' "$HS_CONTAINER" 2>/dev/null || echo "absent")
  echo "container: $HS_CONTAINER ($state)"
  if health; then
    echo "api:       ${api_url}  (healthy)"
  else
    echo "api:       ${api_url}  (not responding)"
  fi
  echo "ui:        http://localhost:${HS_UI_PORT}"
  echo "mcp:       ${api_url}/mcp/${HS_BANK}/"
  echo "bank:      ${HS_BANK}   provider: ${HS_LLM_PROVIDER} / ${HS_LLM_MODEL}"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  logs) logs ;;
  status) status ;;
  *) echo "usage: bash scripts/hindsight.sh up|down|logs|status"; exit 2 ;;
esac
