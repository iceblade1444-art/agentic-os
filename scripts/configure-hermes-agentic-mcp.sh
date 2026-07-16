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

printf '\n' | "$HERMES_BIN" mcp remove agentic-os >/dev/null 2>&1 || true
# Hermes asks whether all discovered tools should be enabled. A blank answer accepts
# the default so this deployment helper also works without an interactive terminal.
printf '\n' | "$HERMES_BIN" mcp add agentic-os \
  --command docker \
  --args exec -i agentic-os node /app/server/mcp/agentic-os-server.js
timeout 30s "$HERMES_BIN" mcp test agentic-os

echo "Hermes can now use Agentic OS and Obsidian tools through MCP."
