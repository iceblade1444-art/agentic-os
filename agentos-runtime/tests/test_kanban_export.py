import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_kanban_export_creates_json_and_markdown(tmp_path):
    run_cli(tmp_path, "init")
    created = run_cli(tmp_path, "new-goal", "Export to Hermes Kanban")
    slug = json.loads(created.stdout)["slug"]

    result = run_cli(tmp_path, "kanban", "export", slug)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "created"
    json_path = Path(data["json"])
    md_path = Path(data["markdown"])
    assert json_path.exists()
    assert md_path.exists()
    export = json.loads(json_path.read_text(encoding="utf-8"))
    assert export["project"] == slug
    assert len(export["tasks"]) == 4
    assert "hermes kanban create" in md_path.read_text(encoding="utf-8")
