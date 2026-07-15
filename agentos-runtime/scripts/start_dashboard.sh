#!/usr/bin/env bash
set -euo pipefail
ROOT="${AGENTOS_ROOT:-C:/Users/User/AgentOS}"
PORT="${AGENTOS_PORT:-8765}"
python "$ROOT/dashboard/backend/app.py" --workspace "$ROOT" --port "$PORT"
