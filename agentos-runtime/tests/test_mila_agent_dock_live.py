import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"
CLI = ROOT / "agentosctl.py"


def call_api(path: str):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(ROOT)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, cwd=str(ROOT))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_agent_dock_endpoint_is_live_read_only_and_secret_safe():
    data = call_api("/api/mila/agent-dock")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_agent_dock_live_state"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["counts"]["projects"] >= 0
    assert data["counts"]["pending_approvals"] >= 0
    assert data["worker"]["status"] in {"disabled", "enabled", "running", "idle", "blocked", "unknown"}
    assert data["latest_report"]["relpath"].startswith("logs/daily/")
    roles = {agent["role"] for agent in data["agents"]}
    assert roles == {"mila"}
    assert data["agents"][0]["display_name"] == "Mila"
    assert data["registry_counts"]["total"] == 1
    assert data["registry_counts"]["real"] == 1
    assert data["safety"]["single_agent_mode"] is True
    matrix_ids = {agent["id"] for agent in data["agent_status_matrix"]}
    assert matrix_ids == {"mila"}
    assert any(agent["connected_to_live_dock"] for agent in data["agent_status_matrix"])
    for agent in data["agents"]:
        assert "display_name" in agent
        assert "status" in agent
        assert "signals" in agent
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob


def test_agent_dock_frontend_loads_live_endpoint_and_renders_cards():
    text = INDEX.read_text(encoding="utf-8")

    required = [
        "milaAgentDockLive",
        "milaAgentDockSummary",
        "loadMilaAgentDock",
        "/api/mila/agent-dock",
        "renderMilaAgentDock",
        "data-mila-agent-role",
        "data-agent-registry-id",
        "registry=",
        "Refresh agent dock",
        "live worker state",
        "Mila",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_live_agent_dock():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_agent_dock_live"] is True
    assert data["checks"]["mila_dashboard_routes"] is True


def test_readme_mentions_phase_2_live_agent_dock():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila live agent dock" in text
    assert "/api/mila/agent-dock" in text
    assert "Mila" in text
