import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"print(json.dumps(handle_api({str(tmp_path)!r}, {path!r}), ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_api_status_returns_counts(tmp_path):
    projects = tmp_path / "projects" / "demo"
    projects.mkdir(parents=True)
    (projects / "project.json").write_text('{"slug":"demo","goal":"Demo"}', encoding="utf-8")
    approvals = tmp_path / "approvals"
    approvals.mkdir()
    (approvals / "approvals.json").write_text('[{"id":"a1","status":"pending"}]', encoding="utf-8")

    result = call_api(tmp_path, "/api/status")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["projects"] == 1
    assert data["pending_approvals"] == 1


def test_api_projects_returns_project_metadata(tmp_path):
    projects = tmp_path / "projects" / "demo"
    projects.mkdir(parents=True)
    (projects / "project.json").write_text('{"slug":"demo","goal":"Demo"}', encoding="utf-8")

    result = call_api(tmp_path, "/api/projects")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data == [{"slug": "demo", "goal": "Demo"}]


def test_api_project_tasks_returns_tasks(tmp_path):
    projects = tmp_path / "projects" / "demo"
    projects.mkdir(parents=True)
    (projects / "tasks.json").write_text('[{"id":"T001","status":"planned"}]', encoding="utf-8")

    result = call_api(tmp_path, "/api/projects/demo/tasks")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data == [{"id": "T001", "status": "planned"}]


def test_api_unknown_path_returns_error(tmp_path):
    result = call_api(tmp_path, "/api/nope")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["error"] == "not_found"
