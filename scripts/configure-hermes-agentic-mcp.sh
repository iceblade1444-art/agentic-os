#!/usr/bin/env bash
set -euo pipefail

HERMES_BIN="${HERMES_BIN:-$HOME/.local/bin/hermes}"

if [[ ! -x "$HERMES_BIN" ]]; then
  echo "Hermes CLI was not found at $HERMES_BIN" >&2
  exit 1
fi

if ! docker inspect agentic-os >/dev/null 2>&1; then
  echo "The agentic-os container is not running" >&2
  exit 1
fi

"$HERMES_BIN" mcp remove agentic-os >/dev/null 2>&1 || true
"$HERMES_BIN" mcp add agentic-os \
  --command docker \
  --args exec -i agentic-os node /app/server/mcp/agentic-os-server.js
"$HERMES_BIN" mcp test agentic-os

echo "Hermes can now use Agentic OS and Obsidian tools through MCP."
