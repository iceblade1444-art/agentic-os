import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def seed_workspace(workspace: Path):
    project_dir = workspace / "projects" / "runner-demo"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"slug": "runner-demo", "goal": "Runner demo"}), encoding="utf-8")
    (project_dir / "tasks.json").write_text(json.dumps([
        {"id": "T001", "project": "runner-demo", "objective": "Produce runner artifact", "owner": "coding-agent", "status": "planned", "depends_on": [], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Artifact exists"], "artifacts": [], "block_reason": None}
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


def test_agent_queue_cli_run_next_executes_first_ready_item(tmp_path):
    seed_workspace(tmp_path)

    result = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent", "--ttl-seconds", "60")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    item = data["item"]
    assert data["status"] == "executed_next"
    assert item["queue_id"] == "runner-demo:T001"
    assert item["status"] == "done"
    assert item["executor"] == "coding-agent"
    assert item["result_summary"].startswith("Executed locally by coding-agent")
    assert item["artifacts"]
    assert Path(item["artifacts"][0]).exists()
    assert Path(item["log_path"]).exists()
    assert item["lease_owner"] is None
    tasks = json.loads((tmp_path / "projects" / "runner-demo" / "tasks.json").read_text(encoding="utf-8"))
    assert tasks[0]["status"] == "done"
    assert item["artifacts"][0] in tasks[0]["artifacts"]


def test_agent_queue_cli_run_next_empty_when_no_ready_items(tmp_path):
    (tmp_path / "projects").mkdir(parents=True, exist_ok=True)

    result = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "empty"
    assert data["item"] is None


def test_agent_queue_api_run_next_executes_ready_item(tmp_path):
    seed_workspace(tmp_path)

    result = call_api(tmp_path, "/api/agent-queue/run-next", method="POST", payload={"worker": "qa-agent", "ttl_seconds": 60})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    item = data["item"]
    assert data["status"] == "executed_next"
    assert item["status"] == "done"
    assert item["executor"] == "qa-agent"
    assert item["artifacts"]
    assert Path(item["artifacts"][0]).exists()


def test_dashboard_contains_run_next_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "runNextAgentQueueItem" in text
    assert "/api/agent-queue/run-next" in text
    assert "Run next safely" in text
