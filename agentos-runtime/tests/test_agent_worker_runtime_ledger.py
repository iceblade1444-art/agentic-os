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
            "objective": f"Runtime ledger task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Runtime ledger trace"],
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
    request = cli_json(workspace, "agent", "worker", "request-enable", "--summary", "Approve runtime ledger")
    approval_id = request["approval"]["id"]
    cli_json(workspace, "approval", "approve", approval_id)
    enabled = cli_json(workspace, "agent", "worker", "enable", "--approval-id", approval_id)
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def approve_api_worker(workspace: Path):
    request = api_json(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Approve runtime ledger"})
    approval_id = request["approval"]["id"]
    api_json(workspace, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    enabled = api_json(workspace, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def load_runs(workspace: Path):
    path = workspace / "logs" / "agent-queue" / "runs.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def load_audits(workspace: Path):
    path = workspace / "logs" / "agent-worker" / "runtime-ticks.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def load_previews(workspace: Path):
    path = workspace / "logs" / "agent-worker" / "runtime-previews.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def test_cli_runtime_preview_ledger_traces_confirmation_to_audit_and_queue_run(tmp_path):
    slug = "runtime-ledger-cli"
    write_project(tmp_path, slug, count=2)
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", slug, "--owner", "coding-agent", "--max-items-per-tick", "1", "--runtime-mode", "execute")
    approval_id = approve_cli_worker(tmp_path)
    before_preview_count = len(load_previews(tmp_path))

    preview = cli_json(tmp_path, "agent", "worker", "runtime-preview", "--pretty")

    assert preview["status"] == "runtime_execute_preview"
    assert preview["preview_id"].startswith("runtime_preview_")
    assert preview["one_shot_run_id"].startswith("runtime_once_")
    assert preview["confirmation"]["token"]
    assert preview["execution_policy"]["scheduler_enabled"] is False
    assert preview["execution_policy"]["manual_only"] is True
    assert preview["execution_policy"]["confirmation_required"] is True
    assert len(load_previews(tmp_path)) == before_preview_count + 1

    listed = cli_json(tmp_path, "agent", "worker", "runtime-previews", "--limit", "1", "--pretty")
    latest_preview = listed["previews"][0]
    assert latest_preview["preview_id"] == preview["preview_id"]
    assert latest_preview["one_shot_run_id"] == preview["one_shot_run_id"]
    assert latest_preview["confirmation"]["token"] == preview["confirmation"]["token"]
    assert latest_preview["approval_id"] == approval_id
    assert latest_preview["queue_ids"] == [f"{slug}:T001"]

    before_runs = len(load_runs(tmp_path))
    before_audits = len(load_audits(tmp_path))
    executed = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--confirmation-token", preview["confirmation"]["token"], "--pretty")

    assert executed["status"] == "runtime_execute_completed"
    assert executed["preview_id"] == preview["preview_id"]
    assert executed["one_shot_run_id"] == preview["one_shot_run_id"]
    assert executed["confirmation"]["accepted"] is True
    assert len(load_runs(tmp_path)) == before_runs + 1
    assert len(load_audits(tmp_path)) == before_audits + 1

    audit = load_audits(tmp_path)[-1]
    assert audit["preview_id"] == preview["preview_id"]
    assert audit["one_shot_run_id"] == preview["one_shot_run_id"]
    assert audit["confirmation"]["token"] == preview["confirmation"]["token"]

    run_record = load_runs(tmp_path)[-1]
    assert run_record["runtime_preview_id"] == preview["preview_id"]
    assert run_record["one_shot_run_id"] == preview["one_shot_run_id"]
    assert run_record["confirmation_token"] == preview["confirmation"]["token"]

    updated_preview = load_previews(tmp_path)[-1]
    assert updated_preview["preview_id"] == preview["preview_id"]
    assert updated_preview["execution_status"] == "runtime_execute_completed"
    assert updated_preview["runtime_audit_id"] == audit["id"]
    assert updated_preview["queue_run_ids"] == [run_record["run_id"]]


def test_api_runtime_preview_ledger_and_token_execution_trace(tmp_path):
    slug = "runtime-ledger-api"
    write_project(tmp_path, slug, count=2, owner="qa-agent")
    api_json(tmp_path, "/api/agent-worker/config", method="POST", payload={"worker": "qa-agent", "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": "qa-agent"}})
    approve_api_worker(tmp_path)

    preview = api_json(tmp_path, "/api/agent-worker/runtime-preview", method="POST", payload={})
    token = preview["confirmation"]["token"]

    assert preview["preview_id"].startswith("runtime_preview_")
    assert preview["one_shot_run_id"].startswith("runtime_once_")
    assert preview["queue_ids"] == [f"{slug}:T001"]

    previews = api_json(tmp_path, "/api/agent-worker/runtime-previews?limit=1")
    assert previews["previews"][0]["preview_id"] == preview["preview_id"]

    executed = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirmation_token": token})

    assert executed["status"] == "runtime_execute_completed"
    assert executed["preview_id"] == preview["preview_id"]
    assert executed["one_shot_run_id"] == preview["one_shot_run_id"]
    audit = load_audits(tmp_path)[-1]
    run_record = load_runs(tmp_path)[-1]
    assert audit["preview_id"] == preview["preview_id"]
    assert run_record["runtime_preview_id"] == preview["preview_id"]
    assert run_record["one_shot_run_id"] == preview["one_shot_run_id"]


def test_dashboard_contains_runtime_ledger_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Runtime Preview Ledger" in text
    assert "loadAgentWorkerRuntimePreviews" in text
    assert "agentWorkerRuntimePreviews" in text
    assert "/api/agent-worker/runtime-previews" in text
    assert "one_shot_run_id" in text
    assert "preview_id" in text
