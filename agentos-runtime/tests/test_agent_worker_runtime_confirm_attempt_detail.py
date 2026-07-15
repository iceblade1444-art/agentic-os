import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def attempts_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json"


def write_attempts(workspace: Path, attempts):
    path = attempts_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(attempts, ensure_ascii=False, indent=2), encoding="utf-8")


def load_attempts(workspace: Path):
    return json.loads(attempts_path(workspace).read_text(encoding="utf-8"))


def attempt(attempt_id: str, runtime_called=True):
    final_status = "runtime_execute_completed" if runtime_called else "confirmation_preflight_blocked"
    preflight_status = "confirmation_token_pending" if runtime_called else "confirmation_token_expired"
    return {
        "id": attempt_id,
        "created_at": "2026-01-01T00:00:00",
        "status": "runtime_confirm_attempt_recorded",
        "final_status": final_status,
        "decision": final_status,
        "runtime_called": runtime_called,
        "preflight_status": preflight_status,
        "preflight_can_execute": runtime_called,
        "preflight_reason": f"reason_{preflight_status}",
        "preview_id": f"preview_{attempt_id}",
        "one_shot_run_id": f"runtime_once_{attempt_id}",
        "confirmation_token": f"token_{attempt_id}",
        "token_status": "consumed" if runtime_called else "expired",
        "executed": 1 if runtime_called else 0,
        "runtime_audit_id": f"runtime_tick_{attempt_id}" if runtime_called else None,
        "queue_run_ids": [f"run_{attempt_id}"] if runtime_called else [],
        "preflight": {"status": preflight_status, "can_execute": runtime_called},
        "result_summary": {"status": final_status, "executed": 1 if runtime_called else 0},
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


def test_api_returns_confirmation_attempt_detail_with_trace_links_read_only(tmp_path):
    write_attempts(tmp_path, [attempt("attempt_alpha", runtime_called=True), attempt("attempt_beta", runtime_called=False)])
    before = load_attempts(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts/attempt_alpha")

    assert result["status"] == "runtime_confirm_attempt_found"
    assert result["decision"] == "runtime_confirm_attempt_detail"
    assert result["attempt_id"] == "attempt_alpha"
    assert result["final_status"] == "runtime_execute_completed"
    assert result["runtime_called"] is True
    assert result["preflight_status"] == "confirmation_token_pending"
    assert result["preview_id"] == "preview_attempt_alpha"
    assert result["one_shot_run_id"] == "runtime_once_attempt_alpha"
    assert result["runtime_audit_id"] == "runtime_tick_attempt_alpha"
    assert result["queue_run_ids"] == ["run_attempt_alpha"]
    assert result["attempt"]["id"] == "attempt_alpha"
    assert result["links"] == {
        "preview_detail": "/api/agent-worker/runtime-previews/preview_attempt_alpha",
        "runtime_audit_id": "runtime_tick_attempt_alpha",
        "runtime_audit_detail": "/api/agent-worker/runtime-audits/runtime_tick_attempt_alpha",
        "queue_run_ids": ["run_attempt_alpha"],
    }
    assert load_attempts(tmp_path) == before


def test_api_returns_confirmation_attempt_not_found_read_only(tmp_path):
    write_attempts(tmp_path, [attempt("attempt_alpha", runtime_called=True)])
    before = load_attempts(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts/missing_attempt")

    assert result["status"] == "runtime_confirm_attempt_not_found"
    assert result["decision"] == "runtime_confirm_attempt_detail"
    assert result["attempt_id"] == "missing_attempt"
    assert result["attempt"] is None
    assert result["links"] == {}
    assert load_attempts(tmp_path) == before


def test_api_detail_does_not_break_filtered_listing(tmp_path):
    write_attempts(tmp_path, [attempt("attempt_alpha", runtime_called=True), attempt("attempt_beta", runtime_called=False)])

    detail = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts/attempt_beta")
    listing = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts?runtime_called=false&limit=0")

    assert detail["status"] == "runtime_confirm_attempt_found"
    assert detail["runtime_called"] is False
    assert listing["status"] == "ok"
    assert listing["matched"] == 1
    assert listing["attempts"][0]["id"] == "attempt_beta"


def test_dashboard_contains_confirmation_attempt_detail_action():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimeConfirmAttemptDetail" in text
    assert "/api/agent-worker/runtime-confirm-attempts/${encodeURIComponent(attemptId)}" in text
    assert "Confirm attempt detail" in text
    assert "showAgentWorkerRuntimeConfirmAttemptDetail(${JSON.stringify(attempt.id || '')})" in text
