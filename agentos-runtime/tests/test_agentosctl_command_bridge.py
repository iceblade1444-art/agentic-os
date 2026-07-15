import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_cli_command_bridge_create_goal(tmp_path):
    run_cli(tmp_path, "init")
    result = run_cli(tmp_path, "command", "создай goal CLI command bridge demo")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["intent"] == "create_goal"
    assert data["result"]["goal"] == "CLI command bridge demo"


def test_cli_command_bridge_digest(tmp_path):
    run_cli(tmp_path, "init")
    run_cli(tmp_path, "new-goal", "CLI digest demo")
    result = run_cli(tmp_path, "command", "покажи digest")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["intent"] == "show_digest"
    assert data["result"]["projects"] == 1
