import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_risk_check_marks_safe_action_auto_allowed(tmp_path):
    run_cli(tmp_path, "init")

    result = run_cli(tmp_path, "risk", "check", "create_draft", "Write local email draft")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["risk"] == "low"
    assert data["requires_approval"] is False
    assert data["decision"] == "auto_allowed"


def test_risk_check_marks_send_email_as_requiring_approval(tmp_path):
    run_cli(tmp_path, "init")

    result = run_cli(tmp_path, "risk", "check", "send_email", "Send outreach email")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["risk"] == "high"
    assert data["requires_approval"] is True
    assert data["decision"] == "approval_required"


def test_risk_request_creates_approval_for_high_risk_action(tmp_path):
    run_cli(tmp_path, "init")

    result = run_cli(tmp_path, "risk", "request", "deploy", "Deploy dashboard to production")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["decision"] == "approval_created"
    assert data["approval"]["action"] == "deploy"
    assert data["approval"]["status"] == "pending"


def test_risk_request_does_not_create_approval_for_low_risk_action(tmp_path):
    run_cli(tmp_path, "init")

    result = run_cli(tmp_path, "risk", "request", "read_file", "Read project brief")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["decision"] == "auto_allowed"
    approvals_file = tmp_path / "approvals" / "approvals.json"
    assert not approvals_file.exists()
