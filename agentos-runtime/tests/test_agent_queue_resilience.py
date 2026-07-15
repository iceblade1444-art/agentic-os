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


def test_agent_queue_cli_fail_retry_cancel_lifecycle(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    assert run_cli(tmp_path, "agent", "queue", "claim", "--queue-id", queue_id, "--worker", "coding-agent").returncode == 0
    assert run_cli(tmp_path, "agent", "queue", "start", "--queue-id", queue_id).returncode == 0
    fail = run_cli(tmp_path, "agent", "queue", "fail", "--queue-id", queue_id, "--reason", "mock failure")
    retry = run_cli(tmp_path, "agent", "queue", "retry", "--queue-id", queue_id)
    cancel = run_cli(tmp_path, "agent", "queue", "cancel", "--queue-id", queue_id, "--reason", "manual stop")

    assert fail.returncode == 0, fail.stderr
    assert retry.returncode == 0, retry.stderr
    assert cancel.returncode == 0, cancel.stderr

    failed_item = json.loads(fail.stdout)["item"]
    retried_item = json.loads(retry.stdout)["item"]
    cancelled_item = json.loads(cancel.stdout)["item"]

    assert failed_item["status"] == "failed"
    assert failed_item["last_error"] == "mock failure"
    assert failed_item["failed_at"]
    assert retried_item["status"] == "queued"
    assert retried_item["retry_count"] == 1
    assert cancelled_item["status"] == "cancelled"
    assert cancelled_item["cancel_reason"] == "manual stop"
    assert cancelled_item["cancelled_at"]


def test_agent_queue_api_fail_and_retry_flow(tmp_path):
    seed_workspace(tmp_path)
    sync = call_api(tmp_path, "/api/agent-queue/sync", method="POST", payload={})
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]
    call_api(tmp_path, "/api/agent-queue/claim", method="POST", payload={"queue_id": queue_id, "worker": "qa-agent"})
    call_api(tmp_path, "/api/agent-queue/start", method="POST", payload={"queue_id": queue_id})

    fail = call_api(tmp_path, "/api/agent-queue/fail", method="POST", payload={"queue_id": queue_id, "reason": "qa failure"})
    retry = call_api(tmp_path, "/api/agent-queue/retry", method="POST", payload={"queue_id": queue_id})

    assert fail.returncode == 0, fail.stderr
    assert retry.returncode == 0, retry.stderr
    failed_item = json.loads(fail.stdout)["item"]
    retried_item = json.loads(retry.stdout)["item"]
    assert failed_item["status"] == "failed"
    assert failed_item["last_error"] == "qa failure"
    assert retried_item["status"] == "queued"
    assert retried_item["retry_count"] == 1


def test_agent_queue_execute_persists_log_path_and_file(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    execute = run_cli(tmp_path, "agent", "queue", "execute", "--queue-id", queue_id, "--worker", "coding-agent")

    assert execute.returncode == 0, execute.stderr
    item = json.loads(execute.stdout)["item"]
    assert item["status"] == "done"
    log_path = Path(item["log_path"])
    assert log_path.exists()
    text = log_path.read_text(encoding="utf-8")
    assert queue_id in text
    assert "completed" in text.lower()


def test_dashboard_contains_resilience_controls_and_log_preview():
    text = INDEX.read_text(encoding="utf-8")
    assert "failAgentQueueItem" in text
    assert "retryAgentQueueItem" in text
    assert "cancelAgentQueueItem" in text
    assert "Run locally" in text
    assert "log=" in text or "log_path" in text
