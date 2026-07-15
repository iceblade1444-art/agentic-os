import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path, method="GET", payload=None):
    payload_literal = repr(payload)
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(tmp_path)!r}, {path!r}, method={method!r}, payload={payload_literal}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_post_goal_creates_project(tmp_path):
    result = call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Create dashboard from UI"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "created"
    assert data["slug"] == "create-dashboard-from-ui"
    assert (tmp_path / "projects" / data["slug"] / "project.json").exists()


def test_post_approval_request_creates_pending_approval_for_high_risk(tmp_path):
    result = call_api(
        tmp_path,
        "/api/approvals/request",
        method="POST",
        payload={"action": "send_email", "summary": "Send a test email"},
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["decision"] == "approval_created"
    assert data["approval"]["status"] == "pending"


def test_post_approval_decision_updates_status(tmp_path):
    created = call_api(
        tmp_path,
        "/api/approvals/request",
        method="POST",
        payload={"action": "send_email", "summary": "Send a test email"},
    )
    approval_id = json.loads(created.stdout)["approval"]["id"]

    result = call_api(tmp_path, f"/api/approvals/{approval_id}/approve", method="POST", payload={})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "approved"
