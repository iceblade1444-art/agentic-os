import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_project(workspace: Path, slug: str, count: int = 3, owner: str = "coding-agent"):
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


def test_cli_run_batch_dry_run_lists_matches_without_execution(tmp_path):
    write_project(tmp_path, "batch-dry", count=3)

    result = run_cli(tmp_path, "agent", "queue", "run-batch", "--worker", "coding-agent", "--project", "batch-dry", "--max-items", "2", "--dry-run")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "dry_run"
    assert data["dry_run"] is True
    assert data["planned"] == 2
    assert [item["queue_id"] for item in data["items"]] == ["batch-dry:T001", "batch-dry:T002"]
    tasks = json.loads((tmp_path / "projects" / "batch-dry" / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["planned", "planned", "planned"]
    assert not (tmp_path / "logs" / "agent-queue" / "runs.json").exists()


def test_cli_run_batch_executes_at_most_max_items(tmp_path):
    write_project(tmp_path, "batch-execute", count=3)

    result = run_cli(tmp_path, "agent", "queue", "run-batch", "--worker", "coding-agent", "--project", "batch-execute", "--max-items", "2")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_batch"
    assert data["executed"] == 2
    assert [item["queue_id"] for item in data["items"]] == ["batch-execute:T001", "batch-execute:T002"]
    tasks = json.loads((tmp_path / "projects" / "batch-execute" / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["done", "done", "planned"]
    runs = json.loads((tmp_path / "logs" / "agent-queue" / "runs.json").read_text(encoding="utf-8"))
    assert [run["queue_id"] for run in runs] == ["batch-execute:T001", "batch-execute:T002"]
    assert all(run["trigger"] == "run_next" for run in runs)


def test_cli_run_batch_owner_filter_only_runs_matching_owner(tmp_path):
    write_project(tmp_path, "batch-code", count=1, owner="coding-agent")
    write_project(tmp_path, "batch-qa", count=2, owner="qa-agent")

    result = run_cli(tmp_path, "agent", "queue", "run-batch", "--worker", "qa-agent", "--owner", "qa-agent", "--max-items", "2")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_batch"
    assert data["executed"] == 2
    assert [item["queue_id"] for item in data["items"]] == ["batch-qa:T001", "batch-qa:T002"]
    code_task = json.loads((tmp_path / "projects" / "batch-code" / "tasks.json").read_text(encoding="utf-8"))[0]
    assert code_task["status"] == "planned"


def test_cli_run_batch_empty_when_no_filter_match(tmp_path):
    write_project(tmp_path, "batch-empty", count=1)

    result = run_cli(tmp_path, "agent", "queue", "run-batch", "--worker", "coding-agent", "--project", "missing", "--max-items", "2")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "empty"
    assert data["executed"] == 0
    assert data["items"] == []
    assert data["filters"]["project"] == "missing"


def test_api_run_batch_executes_bounded_items(tmp_path):
    write_project(tmp_path, "batch-api", count=3)

    result = call_api(tmp_path, "/api/agent-queue/run-batch", method="POST", payload={"worker": "qa-agent", "project": "batch-api", "max_items": 2})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "executed_batch"
    assert data["executed"] == 2
    assert [item["queue_id"] for item in data["items"]] == ["batch-api:T001", "batch-api:T002"]


def test_dashboard_contains_run_batch_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "runAgentQueueBatch" in text
    assert "/api/agent-queue/run-batch" in text
    assert "Run batch dry-run" in text
    assert "Run batch safely" in text
