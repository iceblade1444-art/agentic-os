#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/agentic-os-hermes-chat.service"

mkdir -p "$UNIT_DIR" "$HOME/.local/state/agentic-os"
cat > "$UNIT" <<EOF
[Unit]
Description=Agentic OS Hermes text provider bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HERMES_HOME=$HOME/.hermes
Environment=HERMES_BIN=$HOME/.hermes/hermes-agent/venv/bin/hermes
ExecStart=/usr/bin/python3 $ROOT/scripts/hermes-chat-bridge.py --socket $HOME/.local/state/agentic-os/hermes-chat.sock
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now agentic-os-hermes-chat.service
echo "Agentic OS Hermes chat bridge is active."
