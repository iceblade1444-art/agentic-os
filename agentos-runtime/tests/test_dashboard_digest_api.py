import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(tmp_path)!r}, {path!r}, method={method!r}, payload={repr(payload)}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_digest_api_returns_summary_counts(tmp_path):
    call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Digest API demo"})
    call_api(tmp_path, "/api/approvals/request", method="POST", payload={"action": "send_email", "summary": "Needs approval"})

    result = call_api(tmp_path, "/api/digest")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["projects"] == 1
    assert data["pending_approvals"] == 1
    assert data["events"] >= 2
    assert "markdown" in data
    assert "AgentOS Daily Digest" in data["markdown"]
