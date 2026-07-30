#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Missing $(pwd)/.env" >&2; exit 1; }
[ -t 0 ] || { echo "Run this command from an interactive server terminal." >&2; exit 1; }

DEFAULT_USER="agent@milanapremium.uz"
read -r -p "Corporate mailbox [${DEFAULT_USER}]: " SMTP_USER_INPUT
SMTP_USER_INPUT="${SMTP_USER_INPUT:-$DEFAULT_USER}"
case "$SMTP_USER_INPUT" in
  *@milanapremium.uz) ;;
  *) echo "Use a @milanapremium.uz mailbox." >&2; exit 1 ;;
esac

read -r -s -p "Mailbox password (hidden): " SMTP_PASSWORD_INPUT
echo
[ -n "$SMTP_PASSWORD_INPUT" ] || { echo "Password cannot be empty." >&2; exit 1; }

read -r -p "Send the test message to [${SMTP_USER_INPUT}]: " SMTP_TEST_TO
SMTP_TEST_TO="${SMTP_TEST_TO:-$SMTP_USER_INPUT}"

BACKUP=".env.backup-smtp-$(date -u +%Y%m%dT%H%M%SZ)"
cp .env "$BACKUP"
chmod 600 "$BACKUP"

restore() {
  cp "$BACKUP" .env
  chmod 600 .env
  echo "SMTP check failed. The original .env was restored." >&2
}
trap restore ERR

sed -i \
  -e '/^SMTP_HOST=/d' \
  -e '/^SMTP_PORT=/d' \
  -e '/^SMTP_SECURE=/d' \
  -e '/^SMTP_USER=/d' \
  -e '/^SMTP_PASSWORD=/d' \
  -e '/^SMTP_FROM=/d' \
  -e '/^EMAIL_VERIFICATION_REQUIRED=/d' \
  .env

{
  printf '\nSMTP_HOST=mail.milanapremium.uz\n'
  printf 'SMTP_PORT=587\n'
  printf 'SMTP_SECURE=false\n'
  printf 'SMTP_USER=%s\n' "$SMTP_USER_INPUT"
  printf 'SMTP_PASSWORD=%s\n' "$SMTP_PASSWORD_INPUT"
  printf 'SMTP_FROM="Mila Agentic OS <%s>"\n' "$SMTP_USER_INPUT"
  printf 'EMAIL_VERIFICATION_REQUIRED=false\n'
} >> .env
chmod 600 .env
unset SMTP_PASSWORD_INPUT

docker compose run --rm --no-deps \
  -e SMTP_TEST_TO="$SMTP_TEST_TO" \
  agentic-os npm run smtp:verify

sed -i 's/^EMAIL_VERIFICATION_REQUIRED=false$/EMAIL_VERIFICATION_REQUIRED=true/' .env
docker compose up -d --no-build --no-deps --force-recreate agentic-os

for _ in $(seq 1 20); do
  if curl -fsS https://agent.milanapremium.uz/api/health \
    | grep -q '"deliveryReady":true'; then
    READY=1
    break
  fi
  sleep 2
done
[ "${READY:-0}" = 1 ] || {
  echo "Agentic OS restarted, but email readiness was not confirmed." >&2
  exit 1
}

trap - ERR
echo "Corporate SMTP is active. Email verification and password recovery are ready."
echo "Backup: $(pwd)/${BACKUP}"
