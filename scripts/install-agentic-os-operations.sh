#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
STATE_DIR="$HOME/.local/state/agentic-os"
PYTHON="${OPS_PYTHON:-/usr/bin/python3}"

mkdir -p "$UNIT_DIR" "$STATE_DIR" "$HOME/backups/agentic-os"
chmod 700 "$STATE_DIR" "$HOME/backups/agentic-os"

cat > "$UNIT_DIR/agentic-os-monitor.service" <<EOF
[Unit]
Description=Agentic OS host health monitor
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=-$ROOT/.env
Environment=OPS_STATE_DIR=$STATE_DIR
ExecStart=$PYTHON $ROOT/scripts/agentic-os-operations.py monitor --root $ROOT
EOF

cat > "$UNIT_DIR/agentic-os-monitor.timer" <<'EOF'
[Unit]
Description=Check Agentic OS health every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true
Unit=agentic-os-monitor.service

[Install]
WantedBy=timers.target
EOF

cat > "$UNIT_DIR/agentic-os-backup.service" <<EOF
[Unit]
Description=Create an Agentic OS backup
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=-$ROOT/.env
Environment=OPS_STATE_DIR=$STATE_DIR
ExecStart=$PYTHON $ROOT/scripts/agentic-os-operations.py backup --root $ROOT
EOF

cat > "$UNIT_DIR/agentic-os-backup.timer" <<'EOF'
[Unit]
Description=Create a daily Agentic OS backup

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=15min
Persistent=true
Unit=agentic-os-backup.service

[Install]
WantedBy=timers.target
EOF

cat > "$UNIT_DIR/agentic-os-backup.path" <<EOF
[Unit]
Description=Run an Agentic OS backup requested by the dashboard

[Path]
PathExists=$STATE_DIR/backup.request
Unit=agentic-os-backup.service

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/agentic-os-restore-drill.service" <<EOF
[Unit]
Description=Verify the latest Agentic OS backup can be restored
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=-$ROOT/.env
Environment=OPS_STATE_DIR=$STATE_DIR
ExecStart=$PYTHON $ROOT/scripts/agentic-os-operations.py restore-drill --root $ROOT
EOF

cat > "$UNIT_DIR/agentic-os-restore-drill.path" <<EOF
[Unit]
Description=Run an Agentic OS restore drill requested by the dashboard

[Path]
PathExists=$STATE_DIR/restore.request
Unit=agentic-os-restore-drill.service

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/agentic-os-deep-check.service" <<EOF
[Unit]
Description=Run the complete Agentic OS production smoke suite
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=-$ROOT/.env
ExecStart=/usr/bin/docker compose exec -T -e AGENTIC_OS_INTERNAL_URL=http://127.0.0.1:8787 agentic-os npm run prod:e2e
EOF

cat > "$UNIT_DIR/agentic-os-deep-check.timer" <<'EOF'
[Unit]
Description=Run the complete Agentic OS production smoke suite daily

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=10min
Persistent=true
Unit=agentic-os-deep-check.service

[Install]
WantedBy=timers.target
EOF

chmod 600 "$UNIT_DIR"/agentic-os-{monitor,backup,deep-check}.{service,timer} "$UNIT_DIR/agentic-os-backup.path" "$UNIT_DIR/agentic-os-restore-drill.service" "$UNIT_DIR/agentic-os-restore-drill.path"
systemctl --user daemon-reload
systemctl --user enable --now agentic-os-monitor.timer agentic-os-backup.timer agentic-os-deep-check.timer agentic-os-backup.path agentic-os-restore-drill.path
systemctl --user start agentic-os-backup.service
systemctl --user start agentic-os-restore-drill.service
systemctl --user start agentic-os-monitor.service

echo "Agentic OS operations services installed."
systemctl --user list-timers --all --no-pager | grep -E 'agentic-os-(monitor|backup|deep-check)' || true
