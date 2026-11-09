#!/usr/bin/env bash
# Run the Hindsight memory server locally (optional add-on; see docs/plans/07-hindsight.md).
#
# Usage: bash scripts/hindsight.sh up|down|recreate|logs|status
#
# Hindsight is Vectorize's open-source agent memory (https://hindsight.vectorize.io). This
# runs the official all-in-one image (API + web UI + embedded Postgres) in Docker. The
# Postgres ledger stays the only source of truth; scripts/hindsight-mirror.mts copies it in.
#
# Exposure: ports bind to 127.0.0.1 only. Remote access goes through the Cloudflare tunnel
# (Phase B, docs/plans/07-hindsight.md) or an SSH -L tunnel, never a LAN/tailnet port.
# Auth: when HINDSIGHT_API_KEY is set (.env.local) the REST and MCP endpoints require it as a
# bearer token and the UI uses it to reach the API; HINDSIGHT_UI_ACCESS_KEY is the UI login.
# Env/port changes only apply to a NEW container: `recreate` (data lives in the volume).
set -euo pipefail

# ---- config -------------------------------------------------------------------------
HS_CONTAINER="${HS_CONTAINER:-hindsight}"
HS_IMAGE="${HS_IMAGE:-ghcr.io/vectorize-io/hindsight:latest}"
HS_VOLUME="${HS_VOLUME:-hindsight-data}"          # named volume for the embedded Postgres
HS_BIND="${HS_BIND:-127.0.0.1}"                   # host interface to publish on
HS_API_PORT="${HS_API_PORT:-8888}"                # REST + MCP
HS_UI_PORT="${HS_UI_PORT:-9999}"                  # Control Plane (web UI)
HS_BANK="${HS_BANK:-jlpt-study}"                  # bank id used by mirror/ask and .mcp.json
HS_LLM_PROVIDER="${HS_LLM_PROVIDER:-anthropic}"   # anthropic | claude-code | openai | ...
HS_LLM_MODEL="${HS_LLM_MODEL:-claude-haiku-5-5}"  # cheap default; claude-sonnet-5-5 / claude-opus-5-5 for better reflect answers
HS_ENV_FILE="${HS_ENV_FILE:-.env.local}"          # ANTHROPIC_API_KEY, HINDSIGHT_API_KEY, HINDSIGHT_UI_ACCESS_KEY
# -------------------------------------------------------------------------------------

cd "$(dirname "$0")/.."

api_url="http://${HS_BIND}:${HS_API_PORT}"

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
    echo "hindsight: starting existing container (env/port changes need: recreate)"
    docker start "$HS_CONTAINER" >/dev/null
  else
    local key=""
    case "$HS_LLM_PROVIDER" in
      anthropic) key="${ANTHROPIC_API_KEY:-$(read_env ANTHROPIC_API_KEY)}"
                 [ -n "$key" ] || { echo "ANTHROPIC_API_KEY missing (shell or $HS_ENV_FILE)"; exit 1; } ;;
      claude-code) key="${HS_LLM_API_KEY:-}" ;;   # optional: output of `claude setup-token`
      *) key="${HS_LLM_API_KEY:-}" ;;
    esac
    local api_key ui_key
    api_key="${HINDSIGHT_API_KEY:-$(read_env HINDSIGHT_API_KEY)}"
    ui_key="${HINDSIGHT_UI_ACCESS_KEY:-$(read_env HINDSIGHT_UI_ACCESS_KEY)}"
    local -a auth_flags=()
    if [ -n "$api_key" ]; then
      # Built-in single-tenant API-key auth: bearer token on REST and MCP; the UI's
      # server side uses the same key to call the API inside the container.
      auth_flags+=(
        -e HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension
        -e HINDSIGHT_API_TENANT_API_KEY="$api_key"
        -e HINDSIGHT_CP_DATAPLANE_API_KEY="$api_key"
      )
    else
      echo "hindsight: WARNING HINDSIGHT_API_KEY not set; API and MCP accept anyone who can reach ${HS_BIND}:${HS_API_PORT}"
    fi
    if [ -n "$ui_key" ]; then
      auth_flags+=(-e HINDSIGHT_CP_ACCESS_KEY="$ui_key")
    else
      echo "hindsight: WARNING HINDSIGHT_UI_ACCESS_KEY not set; the UI has no login"
    fi
    echo "hindsight: creating container ($HS_IMAGE, provider=$HS_LLM_PROVIDER, model=$HS_LLM_MODEL, bind=$HS_BIND)"
    # Flags per https://hindsight.vectorize.io/developer/installation (Docker section).
    docker run -d --name "$HS_CONTAINER" --restart unless-stopped \
      --shm-size=1g --stop-timeout 75 \
      -p "${HS_BIND}:${HS_API_PORT}:8888" -p "${HS_BIND}:${HS_UI_PORT}:9999" \
      -e HINDSIGHT_API_LLM_PROVIDER="$HS_LLM_PROVIDER" \
      -e HINDSIGHT_API_LLM_API_KEY="$key" \
      -e HINDSIGHT_API_LLM_MODEL="$HS_LLM_MODEL" \
      -e HINDSIGHT_API_WORKER_ID=jlpt-hub-local \
      "${auth_flags[@]}" \
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

recreate() {
  # Drop the container (NOT the volume) so new env/ports apply; the bank survives.
  if docker ps -a --format '{{.Names}}' | grep -qx "$HS_CONTAINER"; then
    echo "hindsight: removing container $HS_CONTAINER (volume $HS_VOLUME kept)"
    docker rm -f "$HS_CONTAINER" >/dev/null
  fi
  up
}

logs() {
  docker logs -f --tail 200 "$HS_CONTAINER"
}

status() {
  local state auth="off"
  state=$(docker inspect -f '{{.State.Status}}' "$HS_CONTAINER" 2>/dev/null || echo "absent")
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$HS_CONTAINER" 2>/dev/null | grep -q '^HINDSIGHT_API_TENANT_API_KEY='; then
    auth="api-key"
  fi
  echo "container: $HS_CONTAINER ($state)   auth: $auth   bind: $HS_BIND"
  if health; then
    echo "api:       ${api_url}  (healthy)"
  else
    echo "api:       ${api_url}  (not responding)"
  fi
  echo "ui:        http://${HS_BIND}:${HS_UI_PORT}"
  echo "mcp:       ${api_url}/mcp/${HS_BANK}/"
  echo "bank:      ${HS_BANK}   provider: ${HS_LLM_PROVIDER} / ${HS_LLM_MODEL}"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  recreate) recreate ;;
  logs) logs ;;
  status) status ;;
  *) echo "usage: bash scripts/hindsight.sh up|down|recreate|logs|status"; exit 2 ;;
esac
