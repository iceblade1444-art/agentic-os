import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_project(workspace: Path, slug: str, owner: str = "coding-agent"):
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"slug": slug, "goal": f"Goal {slug}"}), encoding="utf-8")
    (project_dir / "tasks.json").write_text(json.dumps([
        {"id": "T001", "project": slug, "objective": f"Execute {slug}", "owner": owner, "status": "planned", "depends_on": [], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Artifact exists"], "artifacts": [], "block_reason": None}
    ]), encoding="utf-8")


def seed_workspace(workspace: Path):
    write_project(workspace, "aaa-oldest", owner="content-agent")
    write_project(workspace, "target-project", owner="coding-agent")
    write_project(workspace, "owner-target", owner="qa-agent")


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


def test_cli_run_next_targets_project_instead_of_oldest(tmp_path):
    seed_workspace(tmp_path)

    result = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent", "--project", "target-project")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_next"
    assert data["item"]["queue_id"] == "target-project:T001"
    assert data["item"]["status"] == "done"
    untouched = json.loads((tmp_path / "projects" / "aaa-oldest" / "tasks.json").read_text(encoding="utf-8"))[0]
    assert untouched["status"] == "planned"


def test_cli_run_next_targets_owner(tmp_path):
    seed_workspace(tmp_path)

    result = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "qa-agent", "--owner", "qa-agent")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_next"
    assert data["item"]["queue_id"] == "owner-target:T001"
    assert data["item"]["executor"] == "qa-agent"


def test_cli_run_next_targets_queue_id(tmp_path):
    seed_workspace(tmp_path)
    assert run_cli(tmp_path, "agent", "queue", "sync").returncode == 0

    result = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent", "--queue-id", "target-project:T001")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_next"
    assert data["item"]["queue_id"] == "target-project:T001"


def test_cli_run_next_target_filter_empty_when_no_match(tmp_path):
    seed_workspace(tmp_path)

    result = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent", "--project", "missing-project")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "empty"
    assert data["item"] is None
    assert data["filters"]["project"] == "missing-project"


def test_api_run_next_targets_project(tmp_path):
    seed_workspace(tmp_path)

    result = call_api(tmp_path, "/api/agent-queue/run-next", method="POST", payload={"worker": "coding-agent", "project": "target-project"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_next"
    assert data["item"]["queue_id"] == "target-project:T001"


def test_dashboard_contains_run_next_targeting_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "runNextAgentQueueItem(item.queue_id" in text or "runNextAgentQueueItem('${item.queue_id}'" in text
    assert "queue_id: queueId" in text
    assert "project: project" in text
    assert "owner: owner" in text
    assert "Run safely" in text
