import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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
            "objective": f"Runtime confirm attempt ledger task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Runtime confirm attempt ledger"],
            "artifacts": [],
            "block_reason": None,
        })
    (project_dir / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")


def call_api(workspace: Path, path: str, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def approve_api_worker(workspace: Path):
    request = call_api(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Approve runtime confirm attempt ledger"})
    approval_id = request["approval"]["id"]
    call_api(workspace, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    enabled = call_api(workspace, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def load_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def load_previews(workspace: Path):
    return load_json(workspace / "logs" / "agent-worker" / "runtime-previews.json", [])


def write_previews(workspace: Path, previews):
    path = workspace / "logs" / "agent-worker" / "runtime-previews.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(previews, ensure_ascii=False, indent=2), encoding="utf-8")


def load_attempts(workspace: Path):
    return load_json(workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json", [])


def load_runs(workspace: Path):
    return load_json(workspace / "logs" / "agent-queue" / "runs.json", [])


def load_audits(workspace: Path):
    return load_json(workspace / "logs" / "agent-worker" / "runtime-ticks.json", [])


def setup_execute_preview(workspace: Path, slug: str = "runtime-confirm-attempt", owner: str = "coding-agent"):
    write_project(workspace, slug, count=2, owner=owner)
    call_api(workspace, "/api/agent-worker/config", method="POST", payload={"worker": owner, "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": owner}})
    approve_api_worker(workspace)
    preview = call_api(workspace, "/api/agent-worker/runtime-preview", method="POST", payload={})
    assert preview["status"] == "runtime_execute_preview"
    return preview


def test_api_gated_execute_records_operator_confirmation_attempt(tmp_path):
    preview = setup_execute_preview(tmp_path, "runtime-confirm-attempt-ok")
    token = preview["confirmation"]["token"]
    before_attempts = len(load_attempts(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": token, "preflight_gate": True})

    assert result["status"] == "runtime_execute_completed"
    assert result["confirm_attempt_id"].startswith("runtime_confirm_attempt_")
    assert result["confirmation_attempt"]["id"] == result["confirm_attempt_id"]
    assert result["confirmation_attempt"]["runtime_called"] is True
    assert result["confirmation_attempt"]["final_status"] == "runtime_execute_completed"
    assert result["confirmation_attempt"]["preflight_status"] == "confirmation_token_pending"
    assert result["confirmation_attempt"]["runtime_audit_id"] == result["audit"]["id"]
    assert len(load_attempts(tmp_path)) == before_attempts + 1

    attempt = load_attempts(tmp_path)[-1]
    assert attempt["id"] == result["confirm_attempt_id"]
    assert attempt["preview_id"] == preview["preview_id"]
    assert attempt["one_shot_run_id"] == preview["one_shot_run_id"]
    assert attempt["confirmation_token"] == token
    assert attempt["runtime_called"] is True
    assert attempt["final_status"] == "runtime_execute_completed"
    assert attempt["executed"] == 1
    assert attempt["runtime_audit_id"] == result["audit"]["id"]
    assert attempt["queue_run_ids"] == result["audit"]["queue_run_ids"]


def test_api_blocked_preflight_records_attempt_without_runtime_audit_or_queue_run(tmp_path):
    preview = setup_execute_preview(tmp_path, "runtime-confirm-attempt-stale")
    token = preview["confirmation"]["token"]
    previews = load_previews(tmp_path)
    previews[-1]["expires_at"] = "2000-01-01T00:00:00"
    write_previews(tmp_path, previews)
    before_previews = load_previews(tmp_path)
    before_runs = load_runs(tmp_path)
    before_audits = load_audits(tmp_path)
    before_attempts = len(load_attempts(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": token, "preflight_gate": True})

    assert result["status"] == "confirmation_preflight_blocked"
    assert result["confirm_attempt_id"].startswith("runtime_confirm_attempt_")
    assert result["confirmation_attempt"]["runtime_called"] is False
    assert result["confirmation_attempt"]["final_status"] == "confirmation_preflight_blocked"
    assert result["confirmation_attempt"]["preflight_status"] == "confirmation_token_expired"
    assert result["confirmation_attempt"]["runtime_audit_id"] is None
    assert result["confirmation_attempt"]["queue_run_ids"] == []
    assert load_previews(tmp_path) == before_previews
    assert load_runs(tmp_path) == before_runs
    assert load_audits(tmp_path) == before_audits
    assert len(load_attempts(tmp_path)) == before_attempts + 1

    attempt = load_attempts(tmp_path)[-1]
    assert attempt["id"] == result["confirm_attempt_id"]
    assert attempt["preview_id"] == preview["preview_id"]
    assert attempt["runtime_called"] is False
    assert attempt["executed"] == 0
    assert attempt["preflight"]["confirmation"]["reason"] == "token_expired"


def test_api_lists_confirmation_attempts_newest_first(tmp_path):
    first = setup_execute_preview(tmp_path, "runtime-confirm-attempt-list-a")
    call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": first["confirmation"]["token"], "preflight_gate": True})
    second = setup_execute_preview(tmp_path, "runtime-confirm-attempt-list-b")
    previews = load_previews(tmp_path)
    previews[-1]["expires_at"] = "2000-01-01T00:00:00"
    write_previews(tmp_path, previews)
    blocked = call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": second["confirmation"]["token"], "preflight_gate": True})

    listed = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts?limit=1")

    assert listed["status"] == "ok"
    assert listed["count"] == 1
    assert listed["total"] == 2
    assert listed["attempts"][0]["id"] == blocked["confirm_attempt_id"]
    assert listed["attempts"][0]["final_status"] == "confirmation_preflight_blocked"
    assert listed["path"].endswith("runtime-confirm-attempts.json")


def test_dashboard_contains_confirmation_attempt_ledger_panel_and_refresh():
    text = INDEX.read_text(encoding="utf-8")
    assert "Runtime Confirm Attempts" in text
    assert "agentWorkerRuntimeConfirmAttempts" in text
    assert "loadAgentWorkerRuntimeConfirmAttempts" in text
    assert "/api/agent-worker/runtime-confirm-attempts" in text
    assert "confirm_attempt_id" in text
    assert "runtime_called" in text
    assert "preflight_status" in text
