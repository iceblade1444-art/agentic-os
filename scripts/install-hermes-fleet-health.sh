#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
STATE_DIR="$HOME/.local/state/agentic-os"

mkdir -p "$UNIT_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR"
chmod 700 "$ROOT/scripts/probe-hermes-fleet.sh"

cat > "$UNIT_DIR/agentic-os-hermes-health.service" <<EOF
[Unit]
Description=Probe Agentic OS Hermes profile models
After=network-online.target hermes-dashboard.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=-$ROOT/.env
Environment=AGENTIC_OS_STATE_DIR=$STATE_DIR
ExecStart=$ROOT/scripts/probe-hermes-fleet.sh
TimeoutStartSec=15min
EOF

cat > "$UNIT_DIR/agentic-os-hermes-health.timer" <<'EOF'
[Unit]
Description=Check Agentic OS Hermes profile models every six hours

[Timer]
OnBootSec=4min
OnUnitActiveSec=6h
AccuracySec=5min
Persistent=true
Unit=agentic-os-hermes-health.service

[Install]
WantedBy=timers.target
EOF

cat > "$UNIT_DIR/agentic-os-hermes-health.path" <<EOF
[Unit]
Description=Run a Hermes fleet probe requested by Agentic OS

[Path]
PathExists=$STATE_DIR/hermes-fleet-health.request
Unit=agentic-os-hermes-health.service

[Install]
WantedBy=default.target
EOF

chmod 600 "$UNIT_DIR"/agentic-os-hermes-health.{service,timer,path}
systemctl --user daemon-reload
systemctl --user enable --now agentic-os-hermes-health.timer agentic-os-hermes-health.path
systemctl --user start agentic-os-hermes-health.service

echo "Hermes fleet health checks installed."
systemctl --user list-timers --all --no-pager | grep agentic-os-hermes-health || true
