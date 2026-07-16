#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_REPO="${HERMES_REPO:-$HOME/.hermes/hermes-agent}"
PYTHON="$HERMES_REPO/venv/bin/python"
PIP="$HERMES_REPO/venv/bin/pip"
APP_ENV="$ROOT/.env"
CONFIG_DIR="$HOME/.config/agentic-os"
SERVICE_DIR="$HOME/.config/systemd/user"
ENV_FILE="$CONFIG_DIR/hermes-dashboard.env"
SERVICE_FILE="$SERVICE_DIR/hermes-dashboard.service"

for required in "$HOME/.local/bin/hermes" "$PYTHON" "$PIP" "$APP_ENV"; do
  if [ ! -e "$required" ]; then
    echo "Missing required file: $required" >&2
    exit 1
  fi
done

echo "Installing official Hermes web dependencies..."
"$PIP" install -e "$HERMES_REPO[web,pty]"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required once to build the official Hermes web UI." >&2
  exit 1
fi
npm --prefix "$HERMES_REPO/web" install
npm --prefix "$HERMES_REPO/web" run build

PASSWORD_HASH="$({ "$PYTHON" - "$APP_ENV" <<'PY'
import sys
from pathlib import Path
from plugins.dashboard_auth.basic import hash_password

value = ""
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if line.startswith("AUTH_TOKEN="):
        value = line.split("=", 1)[1].strip().strip('"').strip("'")
        break
if not value:
    raise SystemExit("AUTH_TOKEN is empty; dashboard auth cannot be configured")
print(hash_password(value))
PY
} 2>/dev/null)"

mkdir -p "$CONFIG_DIR" "$SERVICE_DIR" "$HOME/.local/state/agentic-os"
chmod 700 "$CONFIG_DIR"
SECRET="$($PYTHON -c 'import secrets; print(secrets.token_hex(32))')"
umask 077
cat > "$ENV_FILE" <<EOF
HERMES_DASHBOARD_BASIC_AUTH_USERNAME='admin'
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH='$PASSWORD_HASH'
HERMES_DASHBOARD_BASIC_AUTH_SECRET='$SECRET'
HERMES_DASHBOARD_PUBLIC_URL='https://agent.milanapremium.uz/hermes'
EOF

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Hermes Agent official web dashboard for Agentic OS
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HERMES_REPO
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=$ENV_FILE
ExecStart=$ROOT/scripts/run-hermes-dashboard.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

chmod 600 "$ENV_FILE" "$SERVICE_FILE"
chmod +x "$ROOT/scripts/run-hermes-dashboard.sh"
systemctl --user daemon-reload
systemctl --user enable --now hermes-dashboard.service

# Linger needs sudo on some hosts. This user crontab fallback starts Hermes on
# reboot even when the per-user systemd manager is not started until login.
CRON_MARKER="# agentic-os-hermes-dashboard"
CRON_LINE="@reboot sleep 30 && $ROOT/scripts/run-hermes-dashboard.sh >>$HOME/.local/state/agentic-os/hermes-dashboard.log 2>&1 $CRON_MARKER"
{ crontab -l 2>/dev/null | grep -Fv "$CRON_MARKER" || true; echo "$CRON_LINE"; } | crontab -

echo "Hermes Dashboard service installed."
systemctl --user --no-pager --full status hermes-dashboard.service | sed -n '1,16p'
