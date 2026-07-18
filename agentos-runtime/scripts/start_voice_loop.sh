#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENTOS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
CYCLES="${AGENTOS_VOICE_CYCLES:-3}"
INTERVAL="${AGENTOS_VOICE_INTERVAL:-1}"
python "$ROOT/agentosctl.py" --workspace "$ROOT" voice loop --provider local_file --cycles "$CYCLES" --interval "$INTERVAL"
