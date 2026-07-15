import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def seed_workspace(workspace: Path):
    project_dir = workspace / "projects" / "demo"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"slug": "demo", "goal": "Demo project"}), encoding="utf-8")
    (project_dir / "tasks.json").write_text(json.dumps([
        {"id": "T001", "project": "demo", "objective": "Collect context", "owner": "research-agent", "status": "planned", "depends_on": [], "risk_level": "low", "requires_approval": False, "block_reason": None},
        {"id": "T002", "project": "demo", "objective": "Implement", "owner": "coding-agent", "status": "planned", "depends_on": ["T001"], "risk_level": "low", "requires_approval": False, "block_reason": None},
        {"id": "T003", "project": "demo", "objective": "Approve deploy", "owner": "ops-agent", "status": "planned", "depends_on": [], "risk_level": "high", "requires_approval": True, "block_reason": None},
        {"id": "T004", "project": "demo", "objective": "Blocked task", "owner": "qa-agent", "status": "blocked", "depends_on": [], "risk_level": "low", "requires_approval": False, "block_reason": "Need input"}
    ]), encoding="utf-8")


def run_cli(workspace: Path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True)


def call_api(workspace: Path, path: str, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_agent_queue_sync_creates_ready_queue_entries(tmp_path):
    seed_workspace(tmp_path)

    result = run_cli(tmp_path, "agent", "queue", "sync")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "synced"
    assert data["count"] == 1
    assert data["items"][0]["task_id"] == "T001"
    queue_file = tmp_path / "agents" / "queue.json"
    saved = json.loads(queue_file.read_text(encoding="utf-8"))
    assert saved[0]["task_id"] == "T001"


def test_agent_queue_list_returns_saved_entries(tmp_path):
    seed_workspace(tmp_path)
    run_cli(tmp_path, "agent", "queue", "sync")

    result = run_cli(tmp_path, "agent", "queue", "list")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["count"] == 1
    assert data["items"][0]["owner"] == "research-agent"


def test_agent_queue_api_sync_and_list(tmp_path):
    seed_workspace(tmp_path)

    sync_result = call_api(tmp_path, "/api/agent-queue/sync", method="POST", payload={})
    list_result = call_api(tmp_path, "/api/agent-queue")

    assert sync_result.returncode == 0, sync_result.stderr
    sync_data = json.loads(sync_result.stdout)
    assert sync_data["status"] == "synced"
    assert sync_data["items"][0]["task_id"] == "T001"
    assert list_result.returncode == 0, list_result.stderr
    list_data = json.loads(list_result.stdout)
    assert list_data["count"] == 1
    assert list_data["items"][0]["project"] == "demo"


def test_dashboard_contains_agent_queue_panel():
    text = INDEX.read_text(encoding="utf-8")
    assert "Agent Queue" in text
    assert "loadAgentQueue" in text
    assert "/api/agent-queue" in text
