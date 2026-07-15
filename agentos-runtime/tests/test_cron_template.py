import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_cron_template_creates_digest_script_and_instructions(tmp_path):
    run_cli(tmp_path, "init")

    result = run_cli(tmp_path, "cron", "template", "daily-digest")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "created"
    script = Path(data["script"])
    instructions = Path(data["instructions"])
    assert script.exists()
    assert instructions.exists()
    assert "agentosctl.py" in script.read_text(encoding="utf-8")
    assert "hermes cron create" in instructions.read_text(encoding="utf-8")
