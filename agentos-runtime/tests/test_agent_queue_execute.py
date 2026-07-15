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
        {"id": "T001", "project": "demo", "objective": "Collect context", "owner": "coding-agent", "status": "planned", "depends_on": [], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Draft exists"], "artifacts": [], "block_reason": None}
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


def test_agent_queue_execute_cli_creates_artifact_and_marks_done(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    execute = run_cli(tmp_path, "agent", "queue", "execute", "--queue-id", queue_id, "--worker", "coding-agent")

    assert execute.returncode == 0, execute.stderr
    data = json.loads(execute.stdout)
    assert data["item"]["status"] == "done"
    artifact = Path(data["item"]["artifacts"][0])
    assert artifact.exists()
    text = artifact.read_text(encoding="utf-8")
    assert "Demo project" in text
    tasks = json.loads((tmp_path / "projects" / "demo" / "tasks.json").read_text(encoding="utf-8"))
    assert tasks[0]["status"] == "done"
    assert any("agent-queue" in p for p in tasks[0]["artifacts"])


def test_agent_queue_execute_api_returns_result_summary(tmp_path):
    seed_workspace(tmp_path)
    sync = call_api(tmp_path, "/api/agent-queue/sync", method="POST", payload={})
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    execute = call_api(tmp_path, "/api/agent-queue/execute", method="POST", payload={"queue_id": queue_id, "worker": "qa-agent"})

    assert execute.returncode == 0, execute.stderr
    data = json.loads(execute.stdout)
    assert data["item"]["status"] == "done"
    assert "Executed locally by qa-agent" in data["item"]["result_summary"]
    assert data["item"]["artifacts"]


def test_agent_queue_list_includes_result_fields_after_execute(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]
    run_cli(tmp_path, "agent", "queue", "execute", "--queue-id", queue_id, "--worker", "coding-agent")

    listing = run_cli(tmp_path, "agent", "queue", "list")

    assert listing.returncode == 0, listing.stderr
    item = json.loads(listing.stdout)["items"][0]
    assert item["status"] == "done"
    assert item["artifacts"]
    assert item["result_summary"]


def test_dashboard_contains_agent_queue_execute_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "executeAgentQueueItem" in text
    assert "/api/agent-queue/execute" in text
    assert "Run locally" in text
