#!/usr/bin/env bash
# One-shot deploy for Agentic OS. Run ON THE SERVER from the project directory:
#   bash deploy.sh
set -e
cd "$(dirname "$0")"

if command -v npm >/dev/null 2>&1; then
  echo "· running release test suite…"
  npm test
else
  TEST_IN_IMAGE=1
  echo "· host npm is unavailable; release tests will run in the built application image"
fi

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

  # Only a brand-new install gets its own SESSION_SECRET. When SESSION_SECRET is
  # blank the app falls back to AUTH_TOKEN, and that fallback is what every
  # existing install encrypted its MFA secrets, governance secrets and Google
  # tokens under — writing a fresh value into such an install would make all of
  # it undecryptable and log everyone out. So this runs only in the same branch
  # that just created AUTH_TOKEN, i.e. when there is nothing yet to lose.
  SESSION_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
  if grep -q '^SESSION_SECRET=' .env; then
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_TOKEN}|" .env
  else
    printf '\nSESSION_SECRET=%s\n' "$SESSION_TOKEN" >> .env
  fi
  echo "· generated SESSION_SECRET"
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

# The Python runtime holds approvals and drives the Hermes CLI, and Compose puts
# it on a network every container can reach. Same treatment as speech: a shared
# secret the runtime demands from its one legitimate caller, the Node API.
# Safe to generate on an existing install — it is a request credential, not a
# key anything was encrypted under.
if ! grep -q '^AGENTOS_RUNTIME_TOKEN=..*' .env; then
  RUNTIME_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
  if grep -q '^AGENTOS_RUNTIME_TOKEN=' .env; then
    sed -i "s|^AGENTOS_RUNTIME_TOKEN=.*|AGENTOS_RUNTIME_TOKEN=${RUNTIME_TOKEN}|" .env
  else
    printf '\nAGENTOS_RUNTIME_TOKEN=%s\n' "$RUNTIME_TOKEN" >> .env
  fi
  echo "· generated AgentOS runtime token"
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
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
SPEECH_PROJECT="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' speech 2>/dev/null || true)"
EXTERNAL_SPEECH=false
if [ -n "$SPEECH_PROJECT" ] && [ "$SPEECH_PROJECT" != "$COMPOSE_PROJECT" ]; then
  EXTERNAL_SPEECH=true
  echo "· reusing speech container managed by the ${SPEECH_PROJECT} Compose project"
fi

if [ "${REBUILD_SPEECH:-false}" = "true" ] || ! docker image inspect agentos-speech:latest >/dev/null 2>&1; then
  if [ "$EXTERNAL_SPEECH" = "true" ]; then
    echo "Speech is managed by another Compose project; rebuild it from that project." >&2
    exit 1
  fi
  echo "· building speech service image…"
  docker compose build speech
else
  echo "· reusing existing speech service image"
fi
echo "· building Agentic OS application images…"
docker compose build agentic-os agentos-runtime
if [ "${TEST_IN_IMAGE:-0}" = 1 ]; then
  docker run --rm agentic-os:latest npm test
fi

# Validate the just-built image in an isolated candidate container. It uses
# temporary JSON state and no PostgreSQL adapter, so the production datastore is
# never touched before the candidate answers its own health probe.
CANDIDATE_NAME="agentic-os-candidate"
docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
cleanup_candidate() { docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true; }
trap cleanup_candidate EXIT
docker compose run -d --name "$CANDIDATE_NAME" --no-deps \
  -e PORT=18787 -e DATA_DIR=/tmp/agentic-os-candidate-data \
  -e DATABASE_URL= -e POSTGRES_READ_MODE=json -e POSTGRES_WRITE_MODE=json \
  -e POSTGRES_AUTH_READ_MODE=json -e POSTGRES_AUTH_WRITE_MODE=json \
  agentic-os >/dev/null
for _ in $(seq 1 20); do
  if docker exec "$CANDIDATE_NAME" node -e \
    "fetch('http://127.0.0.1:18787/api/health').then(r=>r.json()).then(v=>process.exit(v.ok?0:1)).catch(()=>process.exit(1))"; then
    CANDIDATE_READY=1
    break
  fi
  sleep 1
done
[ "${CANDIDATE_READY:-0}" = 1 ] || {
  docker logs --tail 100 "$CANDIDATE_NAME"
  echo "Candidate image failed its staging health check" >&2
  exit 1
}
cleanup_candidate
trap - EXIT
echo "· candidate staging health passed"

if [ "$EXTERNAL_SPEECH" = "true" ]; then
  # The standalone speech stack already owns the globally named container.
  # --no-deps prevents Compose from trying to recreate it through depends_on.
  docker compose up -d --no-build --no-deps postgres agentos-runtime agentic-os
else
  docker compose up -d --no-build
fi

# Keep container-written runtime files readable by the host services that create
# backups. The app container runs as root for Claude's persisted config mount,
# so writes like data/onboarding.json can otherwise become root-owned 0600 files.
HOST_UID="$(sed -n -e 's/^RUNTIME_FILE_UID=//p' -e 's/^CLAUDE_CODE_WORKSPACE_UID=//p' .env | tail -n1)"
HOST_GID="$(sed -n -e 's/^RUNTIME_FILE_GID=//p' -e 's/^CLAUDE_CODE_WORKSPACE_GID=//p' .env | tail -n1)"
HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"
docker compose exec -T agentic-os sh -lc "chown -R ${HOST_UID}:${HOST_GID} /app/data /run/agentic-os 2>/dev/null || true; find /app/data -type d -exec chmod 700 {} + 2>/dev/null || true; find /app/data -type f -exec chmod 600 {} + 2>/dev/null || true"

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
[ "${READY:-0}" = 1 ] || {
  echo "(not ready — check: docker compose logs -f)" >&2
  exit 1
}
echo
if command -v npm >/dev/null 2>&1; then
  AGENTIC_OS_INTERNAL_URL="http://${HEALTH_HOST}:${HOST_PORT}" npm run prod:e2e
else
  docker compose exec -T -e AGENTIC_OS_INTERNAL_URL="http://127.0.0.1:8787" agentic-os npm run prod:e2e
fi
echo "· mandatory post-deploy smoke passed"
if systemctl --user is-enabled agentic-os-monitor.timer >/dev/null 2>&1; then
  systemctl --user start --no-block agentic-os-monitor.service
  echo "· queued post-deploy operations check"
fi
echo "──────────────────────────────────────────────"
echo " Agentic OS is up on host port ${HOST_PORT}"
PUBLIC_URL="$(sed -n 's/^PUBLIC_URL=//p' .env | tail -n1)"
[ -n "$PUBLIC_URL" ] && echo " Public URL: ${PUBLIC_URL}"
echo " Login secret remains in the server-side .env (not printed)."
echo " Release gate: tests, candidate health and production E2E passed."
echo " Optional provider activation:"
echo "  • Configure SMTP to enable email verification and password recovery."
echo "  • Configure a Google Web OAuth client to enable Personal Calendar and Inbox."
echo "──────────────────────────────────────────────"
