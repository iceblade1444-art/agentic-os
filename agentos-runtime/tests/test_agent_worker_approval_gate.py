import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


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


def approvals(workspace: Path):
    path = workspace / "approvals" / "approvals.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def test_cli_request_enable_queues_high_risk_approval_and_keeps_worker_disabled(tmp_path):
    configured = run_cli(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", "approval-cli", "--max-items-per-tick", "2")
    assert configured.returncode == 0, configured.stderr

    result = run_cli(tmp_path, "agent", "worker", "request-enable", "--summary", "Enable worker daemon for CLI smoke", "--pretty")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "approval_requested"
    assert data["decision"] == "approval_required"
    assert data["will_execute"] is False
    assert data["approval"]["action"] == "enable_agent_worker_daemon"
    assert data["approval"]["risk"] == "high"
    assert data["approval"]["status"] == "pending"
    assert data["config"]["enabled"] is False
    assert data["config"]["enable_approval_id"] == data["approval"]["id"]
    assert approvals(tmp_path)[-1]["id"] == data["approval"]["id"]

    status = run_cli(tmp_path, "agent", "worker", "status", "--pretty")
    assert status.returncode == 0, status.stderr
    status_data = json.loads(status.stdout)
    assert status_data["status"] == "disabled"
    assert status_data["will_execute"] is False
    assert status_data["approval"]["required"] is True
    assert status_data["approval"]["pending_id"] == data["approval"]["id"]


def test_cli_enable_requires_matching_approved_approval_and_still_starts_no_runtime(tmp_path):
    request = run_cli(tmp_path, "agent", "worker", "request-enable", "--summary", "Need explicit approval")
    assert request.returncode == 0, request.stderr
    approval_id = json.loads(request.stdout)["approval"]["id"]

    blocked = run_cli(tmp_path, "agent", "worker", "enable", "--approval-id", approval_id, "--pretty")
    assert blocked.returncode == 0, blocked.stderr
    blocked_data = json.loads(blocked.stdout)
    assert blocked_data["status"] == "approval_required"
    assert blocked_data["will_execute"] is False
    assert blocked_data["config"]["enabled"] is False

    approved = run_cli(tmp_path, "approval", "approve", approval_id)
    assert approved.returncode == 0, approved.stderr

    enabled = run_cli(tmp_path, "agent", "worker", "enable", "--approval-id", approval_id, "--pretty")
    assert enabled.returncode == 0, enabled.stderr
    enabled_data = json.loads(enabled.stdout)
    assert enabled_data["status"] == "enabled_preview_only"
    assert enabled_data["decision"] == "approved"
    assert enabled_data["will_execute"] is False
    assert enabled_data["scheduler"]["enabled"] is False
    assert enabled_data["config"]["enabled"] is True
    assert enabled_data["config"]["enabled_by_approval"] == approval_id

    tick = run_cli(tmp_path, "agent", "worker", "tick", "--pretty")
    assert tick.returncode == 0, tick.stderr
    tick_data = json.loads(tick.stdout)
    assert tick_data["status"] == "runtime_not_started"
    assert tick_data["executed"] == 0
    assert tick_data["will_execute"] is False


def test_api_request_enable_and_enable_gate_require_approved_approval(tmp_path):
    request = call_api(tmp_path, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Enable worker via API"})
    assert request.returncode == 0, request.stderr
    request_data = json.loads(request.stdout)
    approval_id = request_data["approval"]["id"]
    assert request_data["status"] == "approval_requested"
    assert request_data["approval"]["action"] == "enable_agent_worker_daemon"
    assert request_data["approval"]["risk"] == "high"
    assert request_data["config"]["enabled"] is False

    blocked = call_api(tmp_path, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert blocked.returncode == 0, blocked.stderr
    blocked_data = json.loads(blocked.stdout)
    assert blocked_data["status"] == "approval_required"
    assert blocked_data["will_execute"] is False
    assert blocked_data["config"]["enabled"] is False

    approved = call_api(tmp_path, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    assert approved.returncode == 0, approved.stderr

    enabled = call_api(tmp_path, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert enabled.returncode == 0, enabled.stderr
    enabled_data = json.loads(enabled.stdout)
    assert enabled_data["status"] == "enabled_preview_only"
    assert enabled_data["decision"] == "approved"
    assert enabled_data["config"]["enabled"] is True
    assert enabled_data["will_execute"] is False

    status = call_api(tmp_path, "/api/agent-worker/status")
    assert status.returncode == 0, status.stderr
    status_data = json.loads(status.stdout)
    assert status_data["status"] == "enabled_preview_only"
    assert status_data["approval"]["approved_id"] == approval_id
    assert status_data["scheduler"]["enabled"] is False

    tick = call_api(tmp_path, "/api/agent-worker/tick", method="POST", payload={})
    assert tick.returncode == 0, tick.stderr
    tick_data = json.loads(tick.stdout)
    assert tick_data["status"] == "runtime_not_started"
    assert tick_data["executed"] == 0


def test_dashboard_contains_worker_approval_gate_controls_and_api_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Request enable approval" in text
    assert "Enable with approval" in text
    assert "requestAgentWorkerEnable" in text
    assert "enableAgentWorkerWithApproval" in text
    assert "/api/agent-worker/request-enable" in text
    assert "/api/agent-worker/enable" in text
    assert "enable_agent_worker_daemon" in text
