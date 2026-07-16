#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.local/state/agentic-os"
mkdir -p "$STATE_DIR"

"$ROOT/scripts/run-hermes-dashboard.sh" >>"$STATE_DIR/hermes-dashboard.log" 2>&1 &
for _ in $(seq 1 30); do
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:9119 '; then
    break
  fi
  sleep 1
done

exec python3 "$ROOT/scripts/hermes-socket-proxy.py" "$STATE_DIR/hermes-dashboard.sock"
