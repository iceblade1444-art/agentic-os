import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_tool_registry_is_valid_and_keeps_risky_actions_gated():
    registry = json.loads((ROOT / "config" / "tool-registry.json").read_text(encoding="utf-8"))

    assert registry["version"] == 1
    assert registry["policy"]["default_requires_approval"] is True

    tools = {tool["name"]: tool for tool in registry["tools"]}
    assert tools["dashboard.status"]["requires_approval"] is False
    assert tools["agent_worker.enable"]["risk"] == "high"
    assert tools["agent_worker.enable"]["requires_approval"] is True
    assert tools["external.send_email"]["requires_approval"] is True
    assert tools["voice.gemini_live"]["secret_handling"] == "environment_only"


def test_memory_index_is_valid_and_forbids_secret_storage():
    index = json.loads((ROOT / "memory" / "index.json").read_text(encoding="utf-8"))

    assert index["version"] == 1
    source_paths = {source["path"] for source in index["sources"]}
    assert "memory/decisions.md" in source_paths
    assert "memory/active-projects.md" in source_paths
    assert "API keys" in index["policy"]["do_not_store"]
    assert index["derived_context"]["approvals"] == "approvals/approvals.json"


def test_system_map_and_safety_sops_cover_required_plan_items():
    system_map = (ROOT / "sops" / "system-map.md").read_text(encoding="utf-8")
    least_privilege = (ROOT / "sops" / "agent-least-privilege-policy.md").read_text(encoding="utf-8")
    retention = (ROOT / "sops" / "retention-and-secret-safety.md").read_text(encoding="utf-8")
    status = (ROOT / "logs" / "daily" / "2026-06-22_agentos-step-by-step-plan-status.md").read_text(encoding="utf-8")

    assert "agentosctl.py" in system_map
    assert "dashboard/backend/app.py" in system_map
    assert "approval records" in least_privilege
    assert "External Action Gate" in least_privilege
    assert "pagination" in retention.lower()
    assert "implemented" in retention.lower()
    assert "Completion Matrix" in status
    assert "Strengthen approvals and safety | partial" in status
