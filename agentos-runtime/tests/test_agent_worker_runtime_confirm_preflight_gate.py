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
            "objective": f"Runtime preflight gate task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Runtime confirm preflight gate"],
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
    request = call_api(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Approve runtime confirm preflight gate"})
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


def load_runs(workspace: Path):
    return load_json(workspace / "logs" / "agent-queue" / "runs.json", [])


def load_audits(workspace: Path):
    return load_json(workspace / "logs" / "agent-worker" / "runtime-ticks.json", [])


def setup_execute_preview(workspace: Path, slug: str = "runtime-confirm-gate", owner: str = "coding-agent"):
    write_project(workspace, slug, count=2, owner=owner)
    call_api(workspace, "/api/agent-worker/config", method="POST", payload={"worker": owner, "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": owner}})
    approve_api_worker(workspace)
    preview = call_api(workspace, "/api/agent-worker/runtime-preview", method="POST", payload={})
    assert preview["status"] == "runtime_execute_preview"
    assert preview["token_status"] == "pending"
    return preview


def test_api_runtime_tick_preflight_gate_executes_pending_token_and_reports_preflight(tmp_path):
    preview = setup_execute_preview(tmp_path, "runtime-confirm-gate-ok")
    token = preview["confirmation"]["token"]

    result = call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": token, "preflight_gate": True})

    assert result["status"] == "runtime_execute_completed"
    assert result["preflight_gate"] is True
    assert result["preflight"]["status"] == "confirmation_token_pending"
    assert result["preflight"]["decision"] == "confirmation_preflight"
    assert result["preflight"]["can_execute"] is True
    assert result["preflight"]["will_execute"] is False
    assert result["confirmation"]["accepted"] is True
    assert result["preview_id"] == preview["preview_id"]
    assert result["one_shot_run_id"] == preview["one_shot_run_id"]
    assert len(load_runs(tmp_path)) == 1
    assert len(load_audits(tmp_path)) == 1


def test_api_runtime_tick_preflight_gate_blocks_stale_token_without_mutation(tmp_path):
    preview = setup_execute_preview(tmp_path, "runtime-confirm-gate-stale")
    token = preview["confirmation"]["token"]
    previews = load_previews(tmp_path)
    previews[-1]["expires_at"] = "2000-01-01T00:00:00"
    write_previews(tmp_path, previews)
    before_previews = load_previews(tmp_path)
    before_runs = load_runs(tmp_path)
    before_audits = load_audits(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": token, "preflight_gate": True})

    assert result["status"] == "confirmation_preflight_blocked"
    assert result["decision"] == "confirmation_preflight_blocked"
    assert result["reason"] == "confirmation token expired before execution"
    assert result["executed"] == 0
    assert result["will_execute"] is False
    assert result["dry_run"] is True
    assert result["preflight_gate"] is True
    assert result["preflight"]["status"] == "confirmation_token_expired"
    assert result["preflight"]["can_execute"] is False
    assert result["preflight"]["confirmation"]["reason"] == "token_expired"
    assert load_previews(tmp_path) == before_previews
    assert load_runs(tmp_path) == before_runs
    assert load_audits(tmp_path) == before_audits


def test_api_runtime_tick_preflight_gate_blocks_revoked_token_with_exact_reason(tmp_path):
    preview = setup_execute_preview(tmp_path, "runtime-confirm-gate-revoked")
    token = preview["confirmation"]["token"]
    revoke = call_api(tmp_path, "/api/agent-worker/runtime-preview/revoke", method="POST", payload={"confirmation_token": token, "reason": "operator_cancelled"})
    assert revoke["status"] == "runtime_preview_revoked"
    before_previews = load_previews(tmp_path)
    before_runs = load_runs(tmp_path)
    before_audits = load_audits(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirm_execute": True, "confirmation_token": token, "preflight_gate": True})

    assert result["status"] == "confirmation_preflight_blocked"
    assert result["decision"] == "confirmation_preflight_blocked"
    assert result["reason"] == "confirmation token was revoked before execution"
    assert result["preflight"]["status"] == "confirmation_token_revoked"
    assert result["preflight"]["confirmation"]["reason"] == "token_revoked"
    assert result["preview_id"] == preview["preview_id"]
    assert load_previews(tmp_path) == before_previews
    assert load_runs(tmp_path) == before_runs
    assert load_audits(tmp_path) == before_audits


def test_dashboard_confirm_execute_runs_preflight_gate_before_runtime_tick():
    text = INDEX.read_text(encoding="utf-8")
    assert "preflight_gate" in text
    assert "validateAgentWorkerRuntimePreviewToken(agentWorkerRuntimeConfirmationToken" in text
    assert "preflight.can_execute" in text
    assert "Runtime confirm preflight blocked" in text
    assert "confirmation_preflight_blocked" in text
