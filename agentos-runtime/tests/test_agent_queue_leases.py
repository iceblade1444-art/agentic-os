import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def seed_workspace(workspace: Path):
    project_dir = workspace / "projects" / "lease-demo"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"slug": "lease-demo", "goal": "Lease demo"}), encoding="utf-8")
    (project_dir / "tasks.json").write_text(json.dumps([
        {"id": "T001", "project": "lease-demo", "objective": "Prepare lease-safe artifact", "owner": "coding-agent", "status": "planned", "depends_on": [], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Lease recorded"], "artifacts": [], "block_reason": None}
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


def test_agent_queue_cli_lease_and_heartbeat_fields(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    lease = run_cli(tmp_path, "agent", "queue", "lease", "--queue-id", queue_id, "--worker", "coding-agent", "--ttl-seconds", "60")
    heartbeat = run_cli(tmp_path, "agent", "queue", "heartbeat", "--queue-id", queue_id, "--worker", "coding-agent", "--ttl-seconds", "120")

    assert lease.returncode == 0, lease.stderr
    assert heartbeat.returncode == 0, heartbeat.stderr
    leased_item = json.loads(lease.stdout)["item"]
    heartbeat_item = json.loads(heartbeat.stdout)["item"]
    assert leased_item["status"] == "claimed"
    assert leased_item["claimed_by"] == "coding-agent"
    assert leased_item["lease_owner"] == "coding-agent"
    assert leased_item["lease_acquired_at"]
    assert leased_item["lease_expires_at"]
    assert heartbeat_item["lease_owner"] == "coding-agent"
    assert heartbeat_item["heartbeat_at"]
    assert heartbeat_item["lease_expires_at"] >= leased_item["lease_expires_at"]


def test_agent_queue_cli_requeue_stale_clears_expired_lease(tmp_path):
    seed_workspace(tmp_path)
    sync = run_cli(tmp_path, "agent", "queue", "sync")
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    assert run_cli(tmp_path, "agent", "queue", "lease", "--queue-id", queue_id, "--worker", "coding-agent", "--ttl-seconds", "0").returncode == 0
    stale = run_cli(tmp_path, "agent", "queue", "requeue-stale")

    assert stale.returncode == 0, stale.stderr
    result = json.loads(stale.stdout)
    assert result["requeued"] == 1
    item = result["items"][0]
    assert item["queue_id"] == queue_id
    assert item["status"] == "queued"
    assert item["lease_owner"] is None
    assert item["lease_expires_at"] is None
    assert item["retry_count"] == 1
    assert "stale lease" in item["last_error"]


def test_agent_queue_api_lease_and_requeue_stale_flow(tmp_path):
    seed_workspace(tmp_path)
    sync = call_api(tmp_path, "/api/agent-queue/sync", method="POST", payload={})
    queue_id = json.loads(sync.stdout)["items"][0]["queue_id"]

    lease = call_api(tmp_path, "/api/agent-queue/lease", method="POST", payload={"queue_id": queue_id, "worker": "qa-agent", "ttl_seconds": 0})
    stale = call_api(tmp_path, "/api/agent-queue/requeue-stale", method="POST", payload={})

    assert lease.returncode == 0, lease.stderr
    assert stale.returncode == 0, stale.stderr
    leased_item = json.loads(lease.stdout)["item"]
    stale_result = json.loads(stale.stdout)
    assert leased_item["status"] == "claimed"
    assert leased_item["lease_owner"] == "qa-agent"
    assert stale_result["requeued"] == 1
    assert stale_result["items"][0]["status"] == "queued"
    assert stale_result["items"][0]["retry_count"] == 1


def test_dashboard_contains_lease_controls_and_metadata():
    text = INDEX.read_text(encoding="utf-8")
    assert "leaseAgentQueueItem" in text
    assert "heartbeatAgentQueueItem" in text
    assert "requeueStaleAgentQueueItems" in text
    assert "/api/agent-queue/lease" in text
    assert "/api/agent-queue/heartbeat" in text
    assert "/api/agent-queue/requeue-stale" in text
    assert "lease_owner" in text
    assert "lease_expires_at" in text
