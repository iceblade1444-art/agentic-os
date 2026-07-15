import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_digest_generates_markdown_summary(tmp_path):
    run_cli(tmp_path, "init")
    run_cli(tmp_path, "new-goal", "Build digest demo")
    run_cli(tmp_path, "approval", "create", "send_email", "Send digest email", "--risk", "high")

    result = run_cli(tmp_path, "digest", "daily")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "created"
    digest_path = Path(data["path"])
    assert digest_path.exists()
    text = digest_path.read_text(encoding="utf-8")
    assert "# AgentOS Daily Digest" in text
    assert "Projects: 1" in text
    assert "Pending approvals: 1" in text


def test_digest_json_outputs_counts(tmp_path):
    run_cli(tmp_path, "init")
    run_cli(tmp_path, "new-goal", "Build digest demo")

    result = run_cli(tmp_path, "digest", "daily", "--json-only")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["projects"] == 1
    assert data["pending_approvals"] == 0
    assert "generated_at" in data
