#!/usr/bin/env bash
set -uo pipefail

STATE_DIR="${AGENTIC_OS_STATE_DIR:-$HOME/.local/state/agentic-os}"
STATE_FILE="${HERMES_FLEET_HEALTH_FILE:-$STATE_DIR/hermes-fleet-health.json}"
REQUEST_FILE="${HERMES_FLEET_HEALTH_REQUEST_FILE:-$STATE_DIR/hermes-fleet-health.request}"
LOCK_FILE="$STATE_DIR/hermes-fleet-health.lock"
HERMES_BIN="${HERMES_BIN:-$HOME/.local/bin/hermes}"
PROBE_TIMEOUT="${HERMES_FLEET_PROBE_TIMEOUT:-150}"
EXPECTED="AGENTIC_OS_HEALTH_OK"
PROMPT="Reply with exactly AGENTIC_OS_HEALTH_OK and nothing else."
PROFILES=(default dev reach scout scribe)

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
rm -f "$REQUEST_FILE"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

RESULTS="$(mktemp)"
cleanup() {
  rm -f "$RESULTS" "$REQUEST_FILE"
}
trap cleanup EXIT

write_running_state() {
  local started_at="$1"
  "$HOME/.hermes/hermes-agent/venv/bin/python" - "$STATE_FILE" "$started_at" <<'PY'
import json
import os
import sys
import tempfile

target, started_at = sys.argv[1:3]
previous = {}
try:
    with open(target, encoding="utf-8") as handle:
        previous = json.load(handle)
except (OSError, ValueError):
    pass
payload = {
    "version": 1,
    "status": "running",
    "startedAt": started_at,
    "checkedAt": previous.get("checkedAt"),
    "profiles": previous.get("profiles", {}),
}
directory = os.path.dirname(target)
fd, temporary = tempfile.mkstemp(prefix="hermes-fleet-", suffix=".json", dir=directory)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
    handle.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, target)
PY
}

classify_failure() {
  local exit_code="$1"
  local output="$2"
  if [[ "$exit_code" -eq 124 ]]; then
    printf '%s\t%s' "timeout" "Model probe timed out."
  elif grep -Eiq '401|authentication|unauthorized|token.*(expired|invalid)|login required' <<<"$output"; then
    printf '%s\t%s' "auth_required" "Provider authentication must be renewed."
  elif grep -Eiq 'model.*(not found|unsupported|unavailable)|unknown model' <<<"$output"; then
    printf '%s\t%s' "model_error" "The configured model is unavailable for this provider."
  elif grep -Eiq '429|rate.?limit|quota' <<<"$output"; then
    printf '%s\t%s' "rate_limited" "Provider rate limit or quota was reached."
  elif grep -Eiq 'network|connection|timed out|temporary failure|name resolution' <<<"$output"; then
    printf '%s\t%s' "network_error" "The provider could not be reached."
  else
    printf '%s\t%s' "failed" "Live model probe failed."
  fi
}

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_running_state "$started_at"

for profile in "${PROFILES[@]}"; do
  start_epoch="$(date +%s)"
  if [[ "$profile" == "default" ]]; then
    command=("$HERMES_BIN" "--ignore-rules" "-z" "$PROMPT")
  else
    command=("$HERMES_BIN" "-p" "$profile" "--ignore-rules" "-z" "$PROMPT")
  fi

  set +e
  output="$(timeout "${PROBE_TIMEOUT}s" "${command[@]}" 2>&1)"
  exit_code=$?
  set -e
  end_epoch="$(date +%s)"
  latency_ms=$(((end_epoch - start_epoch) * 1000))
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  clean_output="$(printf '%s\n' "$output" | sed $'s/\033\\[[0-9;]*[[:alpha:]]//g')"
  if [[ "$exit_code" -eq 0 ]] && grep -Fqx "$EXPECTED" <<<"$clean_output"; then
    printf '%s\ttrue\t%s\tok\t\t%s\n' "$profile" "$latency_ms" "$checked_at" >>"$RESULTS"
  else
    failure="$(classify_failure "$exit_code" "$output")"
    code="${failure%%$'\t'*}"
    error="${failure#*$'\t'}"
    printf '%s\tfalse\t%s\t%s\t%s\t%s\n' "$profile" "$latency_ms" "$code" "$error" "$checked_at" >>"$RESULTS"
  fi
done

"$HOME/.hermes/hermes-agent/venv/bin/python" - "$STATE_FILE" "$RESULTS" "$started_at" <<'PY'
import json
import os
import sys
import tempfile

target, results_file, started_at = sys.argv[1:4]
profiles = {}
with open(results_file, encoding="utf-8") as handle:
    for raw in handle:
        name, ok, latency, code, error, checked_at = raw.rstrip("\n").split("\t", 5)
        profiles[name] = {
            "ok": ok == "true",
            "latencyMs": int(latency),
            "code": code,
            "error": error,
            "checkedAt": checked_at,
        }
checked_at = max((item["checkedAt"] for item in profiles.values()), default=None)
payload = {
    "version": 1,
    "status": "healthy" if profiles and all(item["ok"] for item in profiles.values()) else "degraded",
    "startedAt": started_at,
    "checkedAt": checked_at,
    "profiles": profiles,
}
directory = os.path.dirname(target)
fd, temporary = tempfile.mkstemp(prefix="hermes-fleet-", suffix=".json", dir=directory)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
    handle.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, target)
PY
