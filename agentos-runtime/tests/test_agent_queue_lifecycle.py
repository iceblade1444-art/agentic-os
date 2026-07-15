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
        {"id": "T001", "project": "demo", "objective": "Collect context", "owner": "research-agent", "status": "planned", "depends_on": [], "risk_level": "low", "requires_approval": False, "block_reason": None}
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


def test_agent_queue_cli_claim_start_complete_lifecycle(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    assert sync.returncode == 0, sync.stderr
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    claim = run_cli(tmp_path, "agent", "queue", "claim", "--queue-id", queue_id, "--worker", "coding-agent")
    start = run_cli(tmp_path, "agent", "queue", "start", "--queue-id", queue_id)
    complete = run_cli(tmp_path, "agent", "queue", "complete", "--queue-id", queue_id)

    assert claim.returncode == 0, claim.stderr
    assert start.returncode == 0, start.stderr
    assert complete.returncode == 0, complete.stderr
    claim_data = json.loads(claim.stdout)
    start_data = json.loads(start.stdout)
    complete_data = json.loads(complete.stdout)
    assert claim_data["item"]["status"] == "claimed"
    assert claim_data["item"]["claimed_by"] == "coding-agent"
    assert start_data["item"]["status"] == "running"
    assert complete_data["item"]["status"] == "done"
    queue = json.loads((tmp_path / "agents" / "queue.json").read_text(encoding="utf-8"))
    assert queue[0]["status"] == "done"


def test_agent_queue_api_claim_start_complete_lifecycle(tmp_path):
    seed_workspace(tmp_path)
    sync = call_api(tmp_path, "/api/agent-queue/sync", method="POST", payload={})
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    claim = call_api(tmp_path, "/api/agent-queue/claim", method="POST", payload={"queue_id": queue_id, "worker": "qa-agent"})
    start = call_api(tmp_path, "/api/agent-queue/start", method="POST", payload={"queue_id": queue_id})
    complete = call_api(tmp_path, "/api/agent-queue/complete", method="POST", payload={"queue_id": queue_id})

    assert claim.returncode == 0, claim.stderr
    assert start.returncode == 0, start.stderr
    assert complete.returncode == 0, complete.stderr
    assert json.loads(claim.stdout)["item"]["status"] == "claimed"
    assert json.loads(start.stdout)["item"]["status"] == "running"
    assert json.loads(complete.stdout)["item"]["status"] == "done"


def test_agent_queue_rejects_start_before_claim(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    start = run_cli(tmp_path, "agent", "queue", "start", "--queue-id", queue_id)

    assert start.returncode == 0, start.stderr
    data = json.loads(start.stdout)
    assert data["error"] == "queue_item_not_claimed"


def test_dashboard_contains_agent_queue_lifecycle_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "claimAgentQueueItem" in text
    assert "startAgentQueueItem" in text
    assert "completeAgentQueueItem" in text
    assert "/api/agent-queue/claim" in text
