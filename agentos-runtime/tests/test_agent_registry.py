import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_registry():
    return json.loads((ROOT / "agents" / "registry.json").read_text(encoding="utf-8"))


def test_agent_registry_has_hermes_primary_and_mila_voice():
    registry = load_registry()
    agents = {agent["id"]: agent for agent in registry["agents"]}

    assert registry["mode"] == "hermes_orchestrated"
    assert set(agents) == {"hermes", "mila"}
    assert agents["hermes"]["status"] == "real"
    assert agents["hermes"]["kind"] == "primary_orchestrator"
    assert agents["hermes"]["reasoning_provider"] == "openai-codex"
    assert agents["mila"]["status"] == "real"
    assert agents["mila"]["kind"] == "voice_assistant"
    assert agents["mila"]["voice_provider"] == "gemini_live"
    assert agents["mila"]["reasoning_provider"] == "hermes"
    assert agents["mila"]["memory_path"] == "memory/mila-initial-memory.md"


def test_every_frontend_reference_agent_has_registry_entry():
    registry_ids = {agent["id"] for agent in load_registry()["agents"]}
    frontend = (ROOT / "dashboard" / "frontend" / "index.html").read_text(encoding="utf-8")
    match = re.search(r"const AGENTS=\[(.*?)\];", frontend, re.DOTALL)
    assert match
    frontend_ids = set(re.findall(r"\{id:'([^']+)'", match.group(1)))

    assert frontend_ids
    assert frontend_ids.issubset(registry_ids)


def test_mila_memory_and_spec_files_exist():
    registry = load_registry()
    agents = {agent["id"]: agent for agent in registry["agents"]}
    mila = agents["mila"]

    assert (ROOT / mila["spec_path"]).exists()
    assert (ROOT / mila["memory_path"]).exists()
    assert (ROOT / agents["hermes"]["spec_path"]).exists()
    assert (ROOT / "memory" / "mila-learnings.md").exists()
