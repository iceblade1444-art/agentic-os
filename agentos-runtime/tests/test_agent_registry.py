import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_registry():
    return json.loads((ROOT / "agents" / "registry.json").read_text(encoding="utf-8"))


def test_agent_registry_is_single_mila_orchestrator():
    registry = load_registry()
    agents = {agent["id"]: agent for agent in registry["agents"]}

    assert registry["mode"] == "single_agent"
    assert set(agents) == {"mila"}
    assert agents["mila"]["status"] == "real"
    assert agents["mila"]["voice_provider"] == "gemini_live"
    assert agents["mila"]["reasoning_provider"] == "openai_gpt_when_configured"
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
    mila = registry["agents"][0]

    assert (ROOT / mila["spec_path"]).exists()
    assert (ROOT / mila["memory_path"]).exists()
    assert (ROOT / "memory" / "mila-learnings.md").exists()
