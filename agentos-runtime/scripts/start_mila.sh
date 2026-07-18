#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENTOS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
PORT="${AGENTOS_PORT:-8765}"
LOGDIR="$ROOT/logs/runtime"
mkdir -p "$LOGDIR"
echo "Starting Mila AgentOS dashboard on http://127.0.0.1:${PORT}/"
python "$ROOT/dashboard/backend/app.py" --workspace "$ROOT" --port "$PORT" >> "$LOGDIR/mila-dashboard.log" 2>&1 &
PID="$!"
echo "Mila AgentOS dashboard pid=$PID"
echo "Open http://127.0.0.1:${PORT}/"
