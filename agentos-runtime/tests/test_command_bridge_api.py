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


def test_command_bridge_create_goal_russian(tmp_path):
    result = call_api(tmp_path, "/api/command", method="POST", payload={"text": "создай goal Сделай лендинг для SaaS"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["intent"] == "create_goal"
    assert data["result"]["slug"] == "сделай-лендинг-для-saas" or data["result"]["slug"]


def test_command_bridge_digest(tmp_path):
    call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Digest command demo"})

    result = call_api(tmp_path, "/api/command", method="POST", payload={"text": "покажи digest"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["intent"] == "show_digest"
    assert data["result"]["projects"] == 1
    assert "AgentOS Daily Digest" in data["result"]["markdown"]


def test_command_bridge_approval(tmp_path):
    result = call_api(tmp_path, "/api/command", method="POST", payload={"text": "создай approval send_email Отправить письмо клиенту"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["intent"] == "request_approval"
    assert data["result"]["decision"] == "approval_created"
    assert data["result"]["approval"]["action"] == "send_email"


def test_command_bridge_unknown_returns_help(tmp_path):
    result = call_api(tmp_path, "/api/command", method="POST", payload={"text": "что-нибудь странное"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["intent"] == "unknown"
    assert "examples" in data
