#!/usr/bin/env bash
set -euo pipefail

HERMES_BIN="${HERMES_BIN:-$HOME/.local/bin/hermes}"
HERMES_PYTHON="${HERMES_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_ROOT="$REPO_ROOT/hermes/fleet"
PROFILE_ROOT="$HOME/.hermes/profiles"
WORKSPACE_ROOT="${HERMES_FLEET_WORKSPACE_ROOT:-$HOME/hermes-workspaces}"
HERMES_TIMEZONE="${HERMES_TIMEZONE:-Asia/Tashkent}"

if [[ ! -x "$HERMES_BIN" ]]; then
  echo "Hermes CLI was not found at $HERMES_BIN" >&2
  exit 1
fi
if [[ ! -x "$HERMES_PYTHON" ]]; then
  echo "Hermes Python was not found at $HERMES_PYTHON" >&2
  exit 1
fi

for role in orchestrator scout scribe reach dev; do
  if [[ ! -d "$TEMPLATE_ROOT/$role" ]]; then
    echo "Missing fleet template: $TEMPLATE_ROOT/$role" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$WORKSPACE_ROOT/shared"
"$HERMES_BIN" backup --quick --label "before-agentic-os-fleet" >/dev/null
backup="$(find "$HOME/.hermes/state-snapshots" -mindepth 1 -maxdepth 1 -type d \
  -name '*-before-agentic-os-fleet' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
if [[ -z "$backup" || ! -d "$backup" ]]; then
  echo "Hermes did not create the required state snapshot" >&2
  exit 1
fi
chmod -R go-rwx "$backup"
echo "Hermes backup: $backup"

set_profile_toolsets() {
  local config_path="$1"
  shift
  "$HERMES_PYTHON" - "$config_path" "$@" <<'PY'
from pathlib import Path
import os
import stat
import sys
import yaml

path = Path(sys.argv[1])
toolsets = sys.argv[2:]
config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
config["toolsets"] = toolsets
mode = stat.S_IMODE(path.stat().st_mode)
tmp = path.with_name(path.name + ".fleet.tmp")
tmp.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
os.chmod(tmp, mode)
os.replace(tmp, path)
PY
}

enable_platform_toolset() {
  local config_path="$1" platform="$2" toolset="$3"
  "$HERMES_PYTHON" - "$config_path" "$platform" "$toolset" <<'PY'
from pathlib import Path
import os
import stat
import sys
import yaml

path = Path(sys.argv[1])
platform = sys.argv[2]
toolset = sys.argv[3]
config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
platforms = config.setdefault("platform_toolsets", {})
enabled = platforms.setdefault(platform, [])
if toolset not in enabled:
    enabled.append(toolset)
mode = stat.S_IMODE(path.stat().st_mode)
tmp = path.with_name(path.name + ".fleet.tmp")
tmp.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
os.chmod(tmp, mode)
os.replace(tmp, path)
PY
}

python3 - "$HOME/.hermes/SOUL.md" "$TEMPLATE_ROOT/orchestrator/SOUL_APPEND.md" <<'PY'
from pathlib import Path
import re
import sys

target = Path(sys.argv[1])
block = Path(sys.argv[2]).read_text(encoding="utf-8").strip()
text = target.read_text(encoding="utf-8") if target.exists() else ""
pattern = re.compile(
    r"<!-- AGENTIC_OS_FLEET_START -->.*?<!-- AGENTIC_OS_FLEET_END -->",
    re.DOTALL,
)
updated = pattern.sub(block, text) if pattern.search(text) else text.rstrip() + "\n\n" + block + "\n"
target.write_text(updated.lstrip(), encoding="utf-8")
PY
chmod 600 "$HOME/.hermes/SOUL.md"

"$HERMES_BIN" profile describe default --text \
  "Primary Agentic OS orchestrator. Decomposes goals, routes work to specialist profiles, tracks approvals, and synthesizes results for the user in Telegram." >/dev/null

set_profile_toolsets "$HOME/.hermes/config.yaml" hermes-cli kanban
enable_platform_toolset "$HOME/.hermes/config.yaml" cli kanban
enable_platform_toolset "$HOME/.hermes/config.yaml" telegram kanban
"$HERMES_PYTHON" - "$HOME/.hermes/config.yaml" <<'PY'
from pathlib import Path
import sys
import yaml

config = yaml.safe_load(Path(sys.argv[1]).read_text(encoding="utf-8")) or {}
platforms = config.get("platform_toolsets") or {}
missing = [name for name in ("cli", "telegram") if "kanban" not in platforms.get(name, [])]
if missing:
    raise SystemExit("Kanban toolset was not enabled for: " + ", ".join(missing))
PY
"$HERMES_BIN" config set kanban.orchestrator_profile default >/dev/null
"$HERMES_BIN" config set kanban.default_assignee default >/dev/null
"$HERMES_BIN" config set timezone "$HERMES_TIMEZONE" >/dev/null
"$HERMES_BIN" config set kanban.auto_decompose true >/dev/null
"$HERMES_BIN" config set kanban.auto_decompose_per_tick 2 >/dev/null
"$HERMES_BIN" config set kanban.dispatch_in_gateway true >/dev/null
"$HERMES_BIN" config set kanban.max_in_progress 2 >/dev/null
"$HERMES_BIN" config set kanban.max_in_progress_per_profile 1 >/dev/null
"$HERMES_BIN" config set kanban.auto_promote_children true >/dev/null
"$HERMES_BIN" config set dashboard.kanban.lane_by_profile true >/dev/null

configure_profile() {
  local name="$1" description="$2" memory_mb="$3"
  local profile_home="$PROFILE_ROOT/$name"
  local workspace="$WORKSPACE_ROOT/$name"
  local volumes

  if [[ ! -d "$profile_home" ]]; then
    "$HERMES_BIN" profile create "$name" --clone-from default --description "$description"
  else
    "$HERMES_BIN" profile describe "$name" --text "$description" >/dev/null
  fi

  mkdir -p "$workspace"
  install -m 600 "$TEMPLATE_ROOT/$name/SOUL.md" "$profile_home/SOUL.md"
  install -m 644 "$TEMPLATE_ROOT/$name/AGENTS.md" "$workspace/AGENTS.md"
  set_profile_toolsets "$profile_home/config.yaml" hermes-cli

  volumes="[\"$workspace:$workspace\",\"$HOME/.hermes/cache/documents:/output\"]"
  ENV_PATH="$profile_home/.env" DOCKER_VOLUMES="$volumes" python3 <<'PY'
from pathlib import Path
import os

path = Path(os.environ["ENV_PATH"])
updates = {
    "TELEGRAM_BOT_TOKEN": "",
    "TERMINAL_DOCKER_VOLUMES": os.environ["DOCKER_VOLUMES"],
}
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
PY
  chmod 600 "$profile_home/.env"

  "$HERMES_BIN" -p "$name" config set terminal.cwd "$workspace" >/dev/null
  "$HERMES_BIN" -p "$name" config set timezone "$HERMES_TIMEZONE" >/dev/null
  "$HERMES_BIN" -p "$name" config set terminal.docker_volumes "$volumes" >/dev/null
  "$HERMES_BIN" -p "$name" config set terminal.container_cpu 1 >/dev/null
  "$HERMES_BIN" -p "$name" config set terminal.container_memory "$memory_mb" >/dev/null
}

configure_profile scout \
  "Research and trend intelligence: gathers primary sources, compares evidence, identifies market and product signals, and writes cited findings." 2048
configure_profile scribe \
  "Writing and content: turns research and rough ideas into clear drafts, documentation, briefs, scripts, and audience-aware edits." 2048
configure_profile reach \
  "Growth and monetization strategy: develops positioning, offers, campaigns, outreach drafts, partnerships, and measurable experiments." 2048
configure_profile dev \
  "Engineering and automation: implements and tests code, integrations, infrastructure changes, and operational tooling with reviewable handoffs." 4096

"$HERMES_BIN" kanban init >/dev/null
if "$HERMES_BIN" kanban boards list | grep -qE '(^|[[:space:]])agentic-os([[:space:]]|$)'; then
  "$HERMES_BIN" kanban boards switch agentic-os >/dev/null
else
  "$HERMES_BIN" kanban boards create agentic-os \
    --name "Agentic OS" \
    --description "Shared work queue for the Hermes specialist fleet" \
    --color "#7c3aed" \
    --switch \
    --default-workdir "$WORKSPACE_ROOT/shared" >/dev/null
fi
"$HERMES_BIN" kanban boards set-default-workdir agentic-os "$WORKSPACE_ROOT/shared" >/dev/null

if systemctl --user is-active --quiet hermes-gateway.service; then
  systemctl --user restart hermes-gateway.service
  for _ in {1..15}; do
    systemctl --user is-active --quiet hermes-gateway.service && break
    sleep 1
  done
  systemctl --user is-active --quiet hermes-gateway.service
  sleep 2
fi

echo
"$HERMES_BIN" profile list
echo
"$HERMES_BIN" kanban assignees
echo
echo "Hermes fleet configured. Only the default profile owns the Telegram gateway."
