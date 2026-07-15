#!/usr/bin/env bash
set -euo pipefail
ROOT="${AGENTOS_ROOT:-C:/Users/User/AgentOS}"
PORT="${AGENTOS_PORT:-8765}"
LOGDIR="$ROOT/logs/runtime"
mkdir -p "$LOGDIR"
echo "Starting Mila AgentOS dashboard on http://127.0.0.1:${PORT}/"
python "$ROOT/dashboard/backend/app.py" --workspace "$ROOT" --port "$PORT" >> "$LOGDIR/mila-dashboard.log" 2>&1 &
PID="$!"
echo "Mila AgentOS dashboard pid=$PID"
echo "Open http://127.0.0.1:${PORT}/"
