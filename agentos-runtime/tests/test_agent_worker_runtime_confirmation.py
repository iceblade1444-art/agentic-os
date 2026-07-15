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
            "objective": f"Runtime confirmation task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Runtime execution confirmation"],
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
    request = cli_json(workspace, "agent", "worker", "request-enable", "--summary", "Approve runtime confirmation")
    approval_id = request["approval"]["id"]
    cli_json(workspace, "approval", "approve", approval_id)
    enabled = cli_json(workspace, "agent", "worker", "enable", "--approval-id", approval_id)
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def approve_api_worker(workspace: Path):
    request = api_json(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Approve runtime confirmation"})
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


def test_cli_execute_runtime_requires_confirmation_after_approval(tmp_path):
    slug = "runtime-confirm-cli"
    write_project(tmp_path, slug, count=2)
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", slug, "--owner", "coding-agent", "--max-items-per-tick", "1", "--runtime-mode", "execute")
    approve_cli_worker(tmp_path)
    before_runs = run_history_count(tmp_path)
    before_audits = audit_count(tmp_path)

    blocked = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--pretty")

    assert blocked["status"] == "execute_confirmation_required"
    assert blocked["runtime_mode"] == "execute"
    assert blocked["dry_run"] is True
    assert blocked["executed"] == 0
    assert blocked["planned"] == 1
    assert blocked["confirmation"]["required"] is True
    assert blocked["confirmation"]["confirm_execute_arg"] == "--confirm-execute"
    assert blocked["preview"]["items"][0]["queue_id"] == f"{slug}:T001"
    assert run_history_count(tmp_path) == before_runs
    assert audit_count(tmp_path) == before_audits
    assert [task["status"] for task in read_tasks(tmp_path, slug)] == ["planned", "planned"]

    executed = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--confirm-execute", "--pretty")

    assert executed["status"] == "runtime_execute_completed"
    assert executed["dry_run"] is False
    assert executed["executed"] == 1
    assert executed["confirmation"]["accepted"] is True
    assert run_history_count(tmp_path) == before_runs + 1
    assert audit_count(tmp_path) == before_audits + 1
    assert [task["status"] for task in read_tasks(tmp_path, slug)] == ["done", "planned"]


def test_cli_runtime_preview_returns_confirmation_token_without_side_effects(tmp_path):
    slug = "runtime-preview-cli"
    write_project(tmp_path, slug, count=2)
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", slug, "--owner", "coding-agent", "--max-items-per-tick", "2", "--runtime-mode", "execute")
    approve_cli_worker(tmp_path)
    before_runs = run_history_count(tmp_path)
    before_audits = audit_count(tmp_path)

    preview = cli_json(tmp_path, "agent", "worker", "runtime-preview", "--pretty")

    assert preview["status"] == "runtime_execute_preview"
    assert preview["runtime_mode"] == "execute"
    assert preview["dry_run"] is True
    assert preview["will_execute"] is False
    assert preview["planned"] == 2
    assert preview["executed"] == 0
    assert preview["confirmation"]["required"] is True
    assert preview["confirmation"]["token"]
    assert [item["queue_id"] for item in preview["items"]] == [f"{slug}:T001", f"{slug}:T002"]
    assert run_history_count(tmp_path) == before_runs
    assert audit_count(tmp_path) == before_audits
    assert [task["status"] for task in read_tasks(tmp_path, slug)] == ["planned", "planned"]


def test_api_execute_runtime_requires_confirmation_token(tmp_path):
    slug = "runtime-confirm-api"
    write_project(tmp_path, slug, count=2, owner="qa-agent")
    api_json(tmp_path, "/api/agent-worker/config", method="POST", payload={"worker": "qa-agent", "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": "qa-agent"}})
    approve_api_worker(tmp_path)
    before_runs = run_history_count(tmp_path)
    before_audits = audit_count(tmp_path)

    blocked = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={})

    assert blocked["status"] == "execute_confirmation_required"
    assert blocked["executed"] == 0
    assert blocked["confirmation"]["required"] is True
    assert blocked["preview"]["items"][0]["queue_id"] == f"{slug}:T001"
    assert run_history_count(tmp_path) == before_runs
    assert audit_count(tmp_path) == before_audits

    preview = api_json(tmp_path, "/api/agent-worker/runtime-preview", method="POST", payload={})
    token = preview["confirmation"]["token"]
    assert token

    executed = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirmation_token": token})

    assert executed["status"] == "runtime_execute_completed"
    assert executed["runtime_mode"] == "execute"
    assert executed["dry_run"] is False
    assert executed["executed"] == 1
    assert executed["confirmation"]["accepted"] is True
    assert run_history_count(tmp_path) == before_runs + 1
    assert audit_count(tmp_path) == before_audits + 1
    tasks = read_tasks(tmp_path, slug)
    assert [task["status"] for task in tasks] == ["done", "planned"]
    assert tasks[0]["executor"] == "qa-agent"


def test_dashboard_contains_runtime_preview_and_confirmation_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Preview runtime execute" in text
    assert "runAgentWorkerRuntimePreview" in text
    assert "confirm_execute" in text
    assert "confirmation_token" in text
    assert "/api/agent-worker/runtime-preview" in text
    assert "execute_confirmation_required" in text
