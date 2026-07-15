import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_project(workspace: Path, slug: str, count: int = 2, owner: str = "coding-agent"):
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"slug": slug, "goal": f"Goal {slug}"}), encoding="utf-8")
    tasks = []
    for index in range(1, count + 1):
        tasks.append({
            "id": f"T{index:03d}",
            "project": slug,
            "objective": f"Execute {slug} task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Artifact exists"],
            "artifacts": [],
            "block_reason": None,
        })
    (project_dir / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")


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


def test_cli_worker_status_creates_disabled_default_config(tmp_path):
    result = run_cli(tmp_path, "agent", "worker", "status", "--pretty")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "disabled"
    assert data["will_execute"] is False
    assert data["scheduler"]["enabled"] is False
    assert data["config"]["enabled"] is False
    assert data["config"]["dry_run"] is True
    assert data["config"]["max_items_per_tick"] == 1
    assert Path(data["path"]).exists()
    assert json.loads(Path(data["path"]).read_text(encoding="utf-8"))["enabled"] is False


def test_cli_worker_tick_disabled_does_not_execute_items(tmp_path):
    write_project(tmp_path, "worker-disabled", count=2)

    result = run_cli(tmp_path, "agent", "worker", "tick", "--pretty")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "disabled"
    assert data["executed"] == 0
    tasks = json.loads((tmp_path / "projects" / "worker-disabled" / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["planned", "planned"]
    assert not (tmp_path / "logs" / "agent-queue" / "runs.json").exists()


def test_cli_worker_preview_tick_uses_configured_filters_without_execution(tmp_path):
    write_project(tmp_path, "worker-preview", count=3)
    configured = run_cli(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", "worker-preview", "--max-items-per-tick", "2")
    assert configured.returncode == 0, configured.stderr

    result = run_cli(tmp_path, "agent", "worker", "tick", "--preview", "--pretty")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "preview"
    assert data["dry_run"] is True
    assert data["planned"] == 2
    assert data["executed"] == 0
    assert [item["queue_id"] for item in data["items"]] == ["worker-preview:T001", "worker-preview:T002"]
    tasks = json.loads((tmp_path / "projects" / "worker-preview" / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["planned", "planned", "planned"]
    assert not (tmp_path / "logs" / "agent-queue" / "runs.json").exists()


def test_api_worker_status_config_and_preview_tick_are_non_executing(tmp_path):
    write_project(tmp_path, "worker-api", count=2, owner="qa-agent")
    configured = call_api(tmp_path, "/api/agent-worker/config", method="POST", payload={"worker": "qa-agent", "max_items_per_tick": 2, "filters": {"project": "worker-api", "owner": "qa-agent"}})
    assert configured.returncode == 0, configured.stderr
    config_data = json.loads(configured.stdout)
    assert config_data["config"]["worker"] == "qa-agent"
    assert config_data["config"]["filters"]["project"] == "worker-api"
    assert config_data["config"]["enabled"] is False

    status = call_api(tmp_path, "/api/agent-worker/status")
    assert status.returncode == 0, status.stderr
    status_data = json.loads(status.stdout)
    assert status_data["status"] == "disabled"
    assert status_data["will_execute"] is False

    disabled_tick = call_api(tmp_path, "/api/agent-worker/tick", method="POST", payload={})
    assert disabled_tick.returncode == 0, disabled_tick.stderr
    assert json.loads(disabled_tick.stdout)["status"] == "disabled"

    preview = call_api(tmp_path, "/api/agent-worker/tick", method="POST", payload={"preview": True})
    assert preview.returncode == 0, preview.stderr
    preview_data = json.loads(preview.stdout)
    assert preview_data["status"] == "preview"
    assert preview_data["planned"] == 2
    assert preview_data["executed"] == 0
    tasks = json.loads((tmp_path / "projects" / "worker-api" / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["planned", "planned"]
    assert not (tmp_path / "logs" / "agent-queue" / "runs.json").exists()


def test_dashboard_contains_worker_daemon_preview_panel_and_api_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Worker Daemon Preview" in text
    assert "agentWorkerStatus" in text
    assert "loadAgentWorkerStatus" in text
    assert "previewAgentWorkerTick" in text
    assert "/api/agent-worker/status" in text
    assert "/api/agent-worker/tick" in text
