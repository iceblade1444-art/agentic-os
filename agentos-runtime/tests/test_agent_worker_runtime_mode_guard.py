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
            "objective": f"Runtime mode task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Guarded runtime mode"],
            "artifacts": [],
            "block_reason": None,
        })
    (project_dir / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")


def run_cli(workspace: Path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True)


def cli_json(workspace: Path, *args):
    result = run_cli(workspace, *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def call_api(workspace: Path, path: str, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def api_json(workspace: Path, path: str, method="GET", payload=None):
    result = call_api(workspace, path, method=method, payload=payload)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def approve_cli_worker(workspace: Path):
    request = cli_json(workspace, "agent", "worker", "request-enable", "--summary", "Approve guarded runtime mode")
    approval_id = request["approval"]["id"]
    cli_json(workspace, "approval", "approve", approval_id)
    enabled = cli_json(workspace, "agent", "worker", "enable", "--approval-id", approval_id)
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def approve_api_worker(workspace: Path):
    request = api_json(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Approve guarded runtime mode"})
    approval_id = request["approval"]["id"]
    api_json(workspace, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    enabled = api_json(workspace, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def run_history_count(workspace: Path):
    path = workspace / "logs" / "agent-queue" / "runs.json"
    return len(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else 0


def audit_count(workspace: Path):
    path = workspace / "logs" / "agent-worker" / "runtime-ticks.json"
    return len(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else 0


def read_tasks(workspace: Path, slug: str):
    return json.loads((workspace / "projects" / slug / "tasks.json").read_text(encoding="utf-8"))


def test_cli_runtime_mode_defaults_to_dry_run_and_is_configurable(tmp_path):
    status = cli_json(tmp_path, "agent", "worker", "status", "--pretty")
    assert status["config"]["runtime_mode"] == "dry_run"
    assert status["runtime"]["mode"] == "dry_run"
    assert status["runtime"]["execution_guard"] == "dry_run_default"

    configured = cli_json(tmp_path, "agent", "worker", "configure", "--runtime-mode", "execute", "--pretty")
    assert configured["config"]["runtime_mode"] == "execute"
    assert configured["runtime"]["mode"] == "execute"
    assert configured["runtime"]["execution_guard"] == "requires_approval_and_execute_mode"
    assert configured["will_execute"] is False


def test_cli_approved_runtime_tick_stays_dry_run_by_default(tmp_path):
    slug = "runtime-mode-dry-run"
    write_project(tmp_path, slug, count=2)
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", slug, "--owner", "coding-agent", "--max-items-per-tick", "2")
    approval_id = approve_cli_worker(tmp_path)
    before_runs = run_history_count(tmp_path)
    before_audits = audit_count(tmp_path)

    result = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--pretty")

    assert result["status"] == "runtime_dry_run_audited"
    assert result["runtime_mode"] == "dry_run"
    assert result["dry_run"] is True
    assert result["planned"] == 2
    assert result["executed"] == 0
    assert result["audit"]["trigger"] == "manual_runtime_dry_run"
    assert result["audit"]["runtime_mode"] == "dry_run"
    assert result["approval"]["approved_id"] == approval_id
    assert run_history_count(tmp_path) == before_runs
    assert audit_count(tmp_path) == before_audits + 1
    assert [task["status"] for task in read_tasks(tmp_path, slug)] == ["planned", "planned"]


def test_cli_execute_runtime_mode_requires_approval_and_executes_bounded_items(tmp_path):
    slug = "runtime-mode-execute-cli"
    write_project(tmp_path, slug, count=2)
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", slug, "--owner", "coding-agent", "--max-items-per-tick", "1", "--runtime-mode", "execute")

    blocked = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--pretty")
    assert blocked["status"] == "approval_required"
    assert blocked["executed"] == 0
    assert run_history_count(tmp_path) == 0

    approval_id = approve_cli_worker(tmp_path)
    before_audits = audit_count(tmp_path)
    result = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--confirm-execute", "--pretty")

    assert result["status"] == "runtime_execute_completed"
    assert result["runtime_mode"] == "execute"
    assert result["dry_run"] is False
    assert result["planned"] == 1
    assert result["executed"] == 1
    assert result["audit"]["trigger"] == "manual_runtime_execute"
    assert result["audit"]["runtime_mode"] == "execute"
    assert result["audit"]["approval_id"] == approval_id
    assert run_history_count(tmp_path) == 1
    assert audit_count(tmp_path) == before_audits + 1
    tasks = read_tasks(tmp_path, slug)
    assert [task["status"] for task in tasks] == ["done", "planned"]
    assert tasks[0]["executor"] == "coding-agent"


def test_api_execute_runtime_mode_requires_approval_and_executes_bounded_items(tmp_path):
    slug = "runtime-mode-execute-api"
    write_project(tmp_path, slug, count=2, owner="qa-agent")
    api_json(tmp_path, "/api/agent-worker/config", method="POST", payload={"worker": "qa-agent", "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": "qa-agent"}})

    blocked = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={})
    assert blocked["status"] == "approval_required"
    assert blocked["executed"] == 0

    approval_id = approve_api_worker(tmp_path)
    result = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True})

    assert result["status"] == "runtime_execute_completed"
    assert result["runtime_mode"] == "execute"
    assert result["dry_run"] is False
    assert result["planned"] == 1
    assert result["executed"] == 1
    assert result["audit"]["trigger"] == "manual_runtime_execute"
    assert result["audit"]["approval_id"] == approval_id
    assert run_history_count(tmp_path) == 1
    tasks = read_tasks(tmp_path, slug)
    assert [task["status"] for task in tasks] == ["done", "planned"]
    assert tasks[0]["executor"] == "qa-agent"


def test_dashboard_contains_runtime_mode_controls_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Runtime mode: dry_run" in text
    assert "Runtime mode: execute" in text
    assert "setAgentWorkerRuntimeMode" in text
    assert "runtime_mode" in text
    assert "requires_approval_and_execute_mode" in text
    assert "/api/agent-worker/config" in text
