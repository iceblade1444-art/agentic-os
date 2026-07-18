#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENTOS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
PORT="${AGENTOS_PORT:-8765}"
python "$ROOT/dashboard/backend/app.py" --workspace "$ROOT" --port "$PORT"
