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

# 3) build + start
echo "· building and starting the container…"
docker compose up -d --build

# 4) health check
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
echo "──────────────────────────────────────────────"
echo " Agentic OS is up on host port ${HOST_PORT}"
echo " Your login password (AUTH_TOKEN):"
grep '^AUTH_TOKEN=' .env | cut -d= -f2
echo
echo " Next:"
echo "  • Add OPENAI_API_KEY to .env then: docker compose up -d   (unlocks real missions + chat)"
echo "  • Put nginx + TLS in front, and set SECURE_COOKIE=true — see DEPLOY.md"
echo "──────────────────────────────────────────────"
