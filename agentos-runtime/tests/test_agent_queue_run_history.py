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


def read_runs(workspace: Path):
    return json.loads((workspace / "logs" / "agent-queue" / "runs.json").read_text(encoding="utf-8"))


def test_cli_run_next_persists_run_record_and_lists_history(tmp_path):
    write_project(tmp_path, "audit-run-next")

    executed = run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent", "--project", "audit-run-next")

    assert executed.returncode == 0, executed.stderr
    executed_data = json.loads(executed.stdout)
    assert executed_data["status"] == "executed_next"
    runs = read_runs(tmp_path)
    assert len(runs) == 1
    record = runs[0]
    assert record["queue_id"] == "audit-run-next:T001"
    assert record["project"] == "audit-run-next"
    assert record["task_id"] == "T001"
    assert record["worker"] == "coding-agent"
    assert record["trigger"] == "run_next"
    assert record["status"] == "done"
    assert Path(record["artifact_path"]).exists()
    assert Path(record["log_path"]).exists()
    assert record["completed_at"]

    listed = run_cli(tmp_path, "agent", "queue", "runs", "--limit", "5")

    assert listed.returncode == 0, listed.stderr
    listed_data = json.loads(listed.stdout)
    assert listed_data["count"] == 1
    assert listed_data["runs"][0]["queue_id"] == "audit-run-next:T001"


def test_cli_execute_persists_explicit_execution_record(tmp_path):
    write_project(tmp_path, "audit-execute")
    assert run_cli(tmp_path, "agent", "queue", "sync").returncode == 0

    executed = run_cli(tmp_path, "agent", "queue", "execute", "--worker", "coding-agent", "--queue-id", "audit-execute:T001")

    assert executed.returncode == 0, executed.stderr
    runs = read_runs(tmp_path)
    assert len(runs) == 1
    record = runs[0]
    assert record["queue_id"] == "audit-execute:T001"
    assert record["trigger"] == "execute"
    assert record["status"] == "done"


def test_api_agent_queue_runs_lists_persisted_history(tmp_path):
    write_project(tmp_path, "audit-api")
    executed = call_api(tmp_path, "/api/agent-queue/run-next", method="POST", payload={"worker": "qa-agent", "project": "audit-api"})
    assert executed.returncode == 0, executed.stderr
    assert json.loads(executed.stdout)["status"] == "executed_next"

    result = call_api(tmp_path, "/api/agent-queue/runs")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["count"] == 1
    record = data["runs"][0]
    assert record["queue_id"] == "audit-api:T001"
    assert record["worker"] == "qa-agent"
    assert record["trigger"] == "run_next"


def test_run_history_limit_returns_newest_first(tmp_path):
    write_project(tmp_path, "audit-old", owner="coding-agent")
    write_project(tmp_path, "audit-new", owner="qa-agent")
    assert run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "coding-agent", "--project", "audit-old").returncode == 0
    assert run_cli(tmp_path, "agent", "queue", "run-next", "--worker", "qa-agent", "--project", "audit-new").returncode == 0

    listed = run_cli(tmp_path, "agent", "queue", "runs", "--limit", "1")

    assert listed.returncode == 0, listed.stderr
    data = json.loads(listed.stdout)
    assert data["count"] == 2
    assert len(data["runs"]) == 1
    assert data["runs"][0]["queue_id"] == "audit-new:T001"


def test_dashboard_contains_run_history_panel_and_loader():
    text = INDEX.read_text(encoding="utf-8")
    assert "Agent Queue Runs" in text
    assert "agentQueueRuns" in text
    assert "loadAgentQueueRuns" in text
    assert "/api/agent-queue/runs" in text
