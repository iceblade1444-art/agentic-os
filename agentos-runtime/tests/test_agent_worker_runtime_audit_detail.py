import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def audits_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def attempts_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json"


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def audit(audit_id: str):
    return {
        "id": audit_id,
        "created_at": "2026-01-01T00:00:00",
        "status": "runtime_execute_completed",
        "trigger": "manual_confirm_execute",
        "worker": "dashboard-agent",
        "approval_id": "approval_123",
        "preview_id": f"preview_{audit_id}",
        "one_shot_run_id": f"runtime_once_{audit_id}",
        "confirmation_token": f"token_{audit_id}",
        "planned": 1,
        "executed": 1,
        "max_items": 1,
        "queue_ids": [f"queue_{audit_id}"],
        "queue_run_ids": [f"run_{audit_id}"],
        "items": [{"queue_id": f"queue_{audit_id}", "run_id": f"run_{audit_id}"}],
        "execution_policy": {"manual_only": True, "confirmation_required": True},
    }


def attempt(attempt_id: str, audit_id: str):
    return {
        "id": attempt_id,
        "created_at": "2026-01-01T00:00:01",
        "status": "runtime_confirm_attempt_recorded",
        "final_status": "runtime_execute_completed",
        "decision": "runtime_execute_completed",
        "runtime_called": True,
        "preflight_status": "confirmation_token_pending",
        "preflight_can_execute": True,
        "preflight_reason": "token pending",
        "preview_id": f"preview_{audit_id}",
        "one_shot_run_id": f"runtime_once_{audit_id}",
        "confirmation_token": f"token_{audit_id}",
        "token_status": "consumed",
        "executed": 1,
        "runtime_audit_id": audit_id,
        "queue_run_ids": [f"run_{audit_id}"],
        "preflight": {"status": "confirmation_token_pending", "can_execute": True},
        "result_summary": {"status": "runtime_execute_completed", "executed": 1, "runtime_audit_id": audit_id},
    }


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


def test_api_returns_runtime_audit_detail_with_trace_links_read_only(tmp_path):
    write_json(audits_path(tmp_path), [audit("audit_alpha"), audit("audit_beta")])
    before = load_json(audits_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-audits/audit_alpha")

    assert result["status"] == "runtime_audit_found"
    assert result["decision"] == "runtime_audit_detail"
    assert result["audit_id"] == "audit_alpha"
    assert result["runtime_audit_id"] == "audit_alpha"
    assert result["preview_id"] == "preview_audit_alpha"
    assert result["one_shot_run_id"] == "runtime_once_audit_alpha"
    assert result["queue_ids"] == ["queue_audit_alpha"]
    assert result["queue_run_ids"] == ["run_audit_alpha"]
    assert result["audit"]["id"] == "audit_alpha"
    assert result["links"] == {
        "preview_detail": "/api/agent-worker/runtime-previews/preview_audit_alpha",
        "queue_run_ids": ["run_audit_alpha"],
        "queue_run_details": ["/api/agent-queue/runs/run_audit_alpha"],
        "confirmation_token": "token_audit_alpha",
    }
    assert load_json(audits_path(tmp_path)) == before


def test_api_returns_runtime_audit_not_found_read_only(tmp_path):
    write_json(audits_path(tmp_path), [audit("audit_alpha")])
    before = load_json(audits_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-audits/missing_audit")

    assert result["status"] == "runtime_audit_not_found"
    assert result["decision"] == "runtime_audit_detail"
    assert result["audit_id"] == "missing_audit"
    assert result["audit"] is None
    assert result["links"] == {}
    assert load_json(audits_path(tmp_path)) == before


def test_confirmation_attempt_detail_links_to_runtime_audit_detail(tmp_path):
    write_json(audits_path(tmp_path), [audit("audit_alpha")])
    write_json(attempts_path(tmp_path), [attempt("attempt_alpha", "audit_alpha")])
    before_attempts = load_json(attempts_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts/attempt_alpha")

    assert result["status"] == "runtime_confirm_attempt_found"
    assert result["links"]["runtime_audit_detail"] == "/api/agent-worker/runtime-audits/audit_alpha"
    assert result["links"]["runtime_audit_id"] == "audit_alpha"
    assert load_json(attempts_path(tmp_path)) == before_attempts
    assert load_json(audits_path(tmp_path)) == before_audits


def test_runtime_audit_detail_does_not_break_runtime_audit_listing(tmp_path):
    write_json(audits_path(tmp_path), [audit("audit_alpha"), audit("audit_beta")])

    detail = call_api(tmp_path, "/api/agent-worker/runtime-audits/audit_beta")
    listing = call_api(tmp_path, "/api/agent-worker/runtime-audits?limit=0")

    assert detail["status"] == "runtime_audit_found"
    assert listing["total"] == 2
    assert [item["id"] for item in listing["audits"]] == ["audit_beta", "audit_alpha"]


def test_dashboard_contains_runtime_audit_detail_action():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimeAuditDetail" in text
    assert "/api/agent-worker/runtime-audits/${encodeURIComponent(auditId)}" in text
    assert "Runtime audit detail" in text
    assert "showAgentWorkerRuntimeAuditDetail(${JSON.stringify(audit.id || '')})" in text
