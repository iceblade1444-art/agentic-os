#!/usr/bin/env bash
set -euo pipefail
ROOT="${AGENTOS_ROOT:-C:/Users/User/AgentOS}"
CYCLES="${AGENTOS_VOICE_CYCLES:-3}"
INTERVAL="${AGENTOS_VOICE_INTERVAL:-1}"
python "$ROOT/agentosctl.py" --workspace "$ROOT" voice loop --provider local_file --cycles "$CYCLES" --interval "$INTERVAL"
