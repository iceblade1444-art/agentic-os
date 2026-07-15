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


def attempt(attempt_id: str, final_status: str, runtime_called: bool, preflight_status: str, executed=0):
    return {
        "id": attempt_id,
        "created_at": f"2026-01-01T00:00:0{attempt_id[-1] if attempt_id[-1].isdigit() else 0}",
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
        "executed": executed,
        "runtime_audit_id": f"runtime_tick_{attempt_id}" if runtime_called else None,
        "queue_run_ids": [f"run_{attempt_id}"] if runtime_called else [],
        "preflight": {"status": preflight_status, "can_execute": runtime_called, "confirmation": {"reason": "token_pending" if runtime_called else "token_expired"}},
        "result_summary": {"status": final_status, "executed": executed},
    }


def seed_attempts(workspace: Path):
    write_attempts(workspace, [
        attempt("attempt_1", "runtime_execute_completed", True, "confirmation_token_pending", executed=1),
        attempt("attempt_2", "confirmation_preflight_blocked", False, "confirmation_token_expired", executed=0),
        attempt("attempt_3", "confirmation_preflight_blocked", False, "confirmation_token_revoked", executed=0),
        attempt("attempt_4", "runtime_execute_completed", True, "confirmation_token_pending", executed=1),
    ])


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


def test_api_filters_confirmation_attempts_by_final_status_with_summary(tmp_path):
    seed_attempts(tmp_path)
    before = load_attempts(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts?final_status=confirmation_preflight_blocked&limit=0")

    assert result["status"] == "ok"
    assert result["filters"] == {"final_status": "confirmation_preflight_blocked", "runtime_called": None, "preflight_status": None}
    assert result["total"] == 4
    assert result["matched"] == 2
    assert result["count"] == 2
    assert [item["id"] for item in result["attempts"]] == ["attempt_3", "attempt_2"]
    assert result["summary"]["total"] == 4
    assert result["summary"]["runtime_called"]["true"] == 2
    assert result["summary"]["runtime_called"]["false"] == 2
    assert result["summary"]["final_status"]["confirmation_preflight_blocked"] == 2
    assert result["summary"]["final_status"]["runtime_execute_completed"] == 2
    assert result["summary"]["preflight_status"]["confirmation_token_expired"] == 1
    assert load_attempts(tmp_path) == before


def test_api_filters_confirmation_attempts_by_runtime_called_and_preflight_status(tmp_path):
    seed_attempts(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts?runtime_called=false&preflight_status=confirmation_token_expired&limit=0")

    assert result["filters"] == {"final_status": None, "runtime_called": False, "preflight_status": "confirmation_token_expired"}
    assert result["total"] == 4
    assert result["matched"] == 1
    assert result["count"] == 1
    assert result["attempts"][0]["id"] == "attempt_2"
    assert result["attempts"][0]["runtime_called"] is False
    assert result["attempts"][0]["preflight_status"] == "confirmation_token_expired"


def test_api_confirmation_attempt_filters_preserve_limit_and_newest_order(tmp_path):
    seed_attempts(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts?runtime_called=true&limit=1")

    assert result["filters"]["runtime_called"] is True
    assert result["total"] == 4
    assert result["matched"] == 2
    assert result["count"] == 1
    assert [item["id"] for item in result["attempts"]] == ["attempt_4"]
    assert result["summary"]["runtime_called"]["true"] == 2


def test_dashboard_contains_confirmation_attempt_filters_and_summary_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "attemptFilters" in text
    assert "loadAgentWorkerRuntimeConfirmAttempts({ final_status: 'confirmation_preflight_blocked' })" in text
    assert "loadAgentWorkerRuntimeConfirmAttempts({ runtime_called: 'true' })" in text
    assert "loadAgentWorkerRuntimeConfirmAttempts({ preflight_status: 'confirmation_token_expired' })" in text
    assert "attempts summary" in text
    assert "summary.final_status" in text
    assert "summary.runtime_called" in text
    assert "summary.preflight_status" in text
