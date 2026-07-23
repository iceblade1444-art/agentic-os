#!/usr/bin/env bash
# One-shot deploy for Agentic OS. Run ON THE SERVER from the project directory:
#   bash deploy.sh
set -e
cd "$(dirname "$0")"

# 1) ensure .env exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "· created .env from .env.example"
fi

# 2) auto-generate a strong AUTH_TOKEN if it's blank (enables login/auth by default)
if ! grep -q '^AUTH_TOKEN=..*' .env; then
  TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
  sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=${TOKEN}|" .env
  echo "· generated AUTH_TOKEN"
fi

# Speech traffic stays on the private Compose network, but still uses a
# separate shared secret so another container cannot call STT/TTS directly.
if ! grep -q '^SPEECH_INTERNAL_SECRET=..*' .env; then
  SPEECH_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
  if grep -q '^SPEECH_INTERNAL_SECRET=' .env; then
    sed -i "s|^SPEECH_INTERNAL_SECRET=.*|SPEECH_INTERNAL_SECRET=${SPEECH_TOKEN}|" .env
  else
    printf '\nSPEECH_INTERNAL_SECRET=%s\n' "$SPEECH_TOKEN" >> .env
  fi
  echo "· generated speech service internal secret"
fi

# 3) keep Claude Code login state outside the replaceable app container
CLAUDE_CONFIG_DIR="$(sed -n 's/^CLAUDE_CONFIG_DIR=//p' .env | tail -n1)"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/home/admilana/.claude}"
CLAUDE_CONFIG_FILE="$(sed -n 's/^CLAUDE_CONFIG_FILE=//p' .env | tail -n1)"
CLAUDE_CONFIG_FILE="${CLAUDE_CONFIG_FILE:-/home/admilana/.claude.json}"
mkdir -p "$CLAUDE_CONFIG_DIR" "$(dirname "$CLAUDE_CONFIG_FILE")"
if [ ! -s "$CLAUDE_CONFIG_FILE" ]; then
  LATEST_CLAUDE_BACKUP="$(find "$CLAUDE_CONFIG_DIR/backups" -maxdepth 1 -type f -name '.claude.json.backup.*' 2>/dev/null | sort | tail -n1)"
  if [ -n "$LATEST_CLAUDE_BACKUP" ]; then
    cp "$LATEST_CLAUDE_BACKUP" "$CLAUDE_CONFIG_FILE"
    echo "· restored persistent Claude Code login configuration"
  else
    printf '{}\n' > "$CLAUDE_CONFIG_FILE"
    echo "· created persistent Claude Code configuration"
  fi
fi
chmod 600 "$CLAUDE_CONFIG_FILE"

# Restart the optional host-side Hermes text bridge after code updates.
if systemctl --user is-enabled agentic-os-hermes-chat.service >/dev/null 2>&1; then
  systemctl --user restart agentic-os-hermes-chat.service
  echo "· restarted Hermes text provider bridge"
fi

# 4) build + start. Speech images contain several gigabytes of ML packages and
# model tooling, so normal application deploys reuse the last verified image.
# Rebuild it explicitly after speech-service changes:
#   REBUILD_SPEECH=true bash deploy.sh
if [ "${REBUILD_SPEECH:-false}" = "true" ] || ! docker image inspect agentos-speech:latest >/dev/null 2>&1; then
  echo "· building speech service image…"
  docker compose build speech
else
  echo "· reusing existing speech service image"
fi
echo "· building Agentic OS application images…"
docker compose build agentic-os agentos-runtime
docker compose up -d --no-build

# 5) health check
HOST_PORT="$(sed -n 's/^HOST_PORT=//p' .env | tail -n1)"
HOST_PORT="${HOST_PORT:-8787}"
BIND_ADDRESS="$(sed -n 's/^BIND_ADDRESS=//p' .env | tail -n1)"
HEALTH_HOST="${BIND_ADDRESS:-127.0.0.1}"
# Wildcard listen addresses are not valid health-check destinations.
[ "$HEALTH_HOST" = "0.0.0.0" ] && HEALTH_HOST="127.0.0.1"
echo -n "· health: "
for _ in $(seq 1 15); do
  if curl -fsS "http://${HEALTH_HOST}:${HOST_PORT}/api/health"; then
    READY=1
    break
  fi
  sleep 1
done
[ "${READY:-0}" = 1 ] || echo "(not ready — check: docker compose logs -f)"
echo
if systemctl --user is-enabled agentic-os-monitor.timer >/dev/null 2>&1; then
  systemctl --user start --no-block agentic-os-monitor.service
  echo "· queued post-deploy operations check"
fi
echo "──────────────────────────────────────────────"
echo " Agentic OS is up on host port ${HOST_PORT}"
echo " Login secret remains in the server-side .env (not printed)."
echo " Next:"
echo "  • Add OPENAI_API_KEY to .env then: docker compose up -d   (unlocks real missions + chat)"
echo "  • Put nginx + TLS in front, and set SECURE_COOKIE=true — see DEPLOY.md"
echo "──────────────────────────────────────────────"
