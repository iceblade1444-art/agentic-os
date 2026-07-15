import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def previews_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def attempts_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json"


def audits_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def runs_path(workspace: Path):
    return workspace / "logs" / "agent-queue" / "runs.json"


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def preview(one_shot_run_id="runtime_once_alpha"):
    return {
        "id": "preview_alpha",
        "preview_id": "preview_alpha",
        "one_shot_run_id": one_shot_run_id,
        "status": "runtime_execute_preview",
        "execution_status": "runtime_execute_completed",
        "token_status": "consumed",
        "confirmation": {"token": "token_alpha", "accepted": True},
        "runtime_audit_id": "audit_alpha",
        "queue_ids": ["queue_run_alpha", "queue_run_beta"],
        "queue_run_ids": ["run_alpha", "run_beta"],
    }


def attempt(attempt_id="attempt_alpha", one_shot_run_id="runtime_once_alpha"):
    return {
        "id": attempt_id,
        "created_at": "2026-01-01T00:00:02",
        "status": "runtime_confirm_attempt_recorded",
        "final_status": "runtime_execute_completed",
        "runtime_called": True,
        "preflight_status": "confirmation_token_pending",
        "preview_id": "preview_alpha",
        "one_shot_run_id": one_shot_run_id,
        "confirmation_token": "token_alpha",
        "runtime_audit_id": "audit_alpha",
        "queue_run_ids": ["run_alpha", "run_beta"],
    }


def audit(one_shot_run_id="runtime_once_alpha"):
    return {
        "id": "audit_alpha",
        "created_at": "2026-01-01T00:00:03",
        "status": "runtime_execute_completed",
        "preview_id": "preview_alpha",
        "one_shot_run_id": one_shot_run_id,
        "confirmation_token": "token_alpha",
        "queue_ids": ["queue_run_alpha", "queue_run_beta"],
        "queue_run_ids": ["run_alpha", "run_beta"],
        "items": [{"queue_id": "queue_run_alpha", "run_id": "run_alpha"}, {"queue_id": "queue_run_beta", "run_id": "run_beta"}],
        "executed": 2,
    }


def queue_run(run_id: str, one_shot_run_id="runtime_once_alpha"):
    return {
        "run_id": run_id,
        "queue_id": f"queue_{run_id}",
        "project": "project_alpha",
        "task_id": run_id.replace("run_", "T"),
        "trigger": "runtime_confirm_execute",
        "status": "done",
        "runtime_preview_id": "preview_alpha",
        "one_shot_run_id": one_shot_run_id,
        "confirmation_token": "token_alpha",
        "execution_context": {
            "runtime_preview_id": "preview_alpha",
            "one_shot_run_id": one_shot_run_id,
            "confirmation_token": "token_alpha",
        },
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


def seed_full_trace(workspace: Path):
    write_json(previews_path(workspace), [preview(), preview("runtime_once_other")])
    write_json(attempts_path(workspace), [attempt(), attempt("attempt_beta", "runtime_once_other")])
    write_json(audits_path(workspace), [audit(), audit("runtime_once_other")])
    write_json(runs_path(workspace), [queue_run("run_alpha"), queue_run("run_beta"), queue_run("run_other", "runtime_once_other")])


def test_api_returns_end_to_end_runtime_trace_graph_read_only(tmp_path):
    seed_full_trace(tmp_path)
    before_previews = load_json(previews_path(tmp_path))
    before_attempts = load_json(attempts_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))
    before_runs = load_json(runs_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_alpha")

    assert result["status"] == "runtime_trace_found"
    assert result["decision"] == "runtime_trace_graph"
    assert result["one_shot_run_id"] == "runtime_once_alpha"
    assert result["preview_id"] == "preview_alpha"
    assert result["confirmation_token"] == "token_alpha"
    assert result["runtime_audit_id"] == "audit_alpha"
    assert result["confirm_attempt_ids"] == ["attempt_alpha"]
    assert result["queue_run_ids"] == ["run_alpha", "run_beta"]
    assert result["counts"] == {"previews": 1, "confirmation_attempts": 1, "runtime_audits": 1, "queue_runs": 2}
    assert result["trace"]["preview"]["preview_id"] == "preview_alpha"
    assert [item["id"] for item in result["trace"]["confirmation_attempts"]] == ["attempt_alpha"]
    assert result["trace"]["runtime_audit"]["id"] == "audit_alpha"
    assert [item["run_id"] for item in result["trace"]["queue_runs"]] == ["run_alpha", "run_beta"]
    assert result["links"] == {
        "preview_detail": "/api/agent-worker/runtime-previews/preview_alpha",
        "confirm_attempt_details": ["/api/agent-worker/runtime-confirm-attempts/attempt_alpha"],
        "runtime_audit_detail": "/api/agent-worker/runtime-audits/audit_alpha",
        "queue_run_details": ["/api/agent-queue/runs/run_alpha", "/api/agent-queue/runs/run_beta"],
    }
    assert load_json(previews_path(tmp_path)) == before_previews
    assert load_json(attempts_path(tmp_path)) == before_attempts
    assert load_json(audits_path(tmp_path)) == before_audits
    assert load_json(runs_path(tmp_path)) == before_runs


def test_api_returns_partial_trace_when_only_attempt_exists(tmp_path):
    write_json(previews_path(tmp_path), [])
    write_json(attempts_path(tmp_path), [attempt("attempt_only", "runtime_once_partial")])
    write_json(audits_path(tmp_path), [])
    write_json(runs_path(tmp_path), [])

    result = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_partial")

    assert result["status"] == "runtime_trace_found"
    assert result["one_shot_run_id"] == "runtime_once_partial"
    assert result["preview_id"] == "preview_alpha"
    assert result["runtime_audit_id"] == "audit_alpha"
    assert result["confirm_attempt_ids"] == ["attempt_only"]
    assert result["queue_run_ids"] == ["run_alpha", "run_beta"]
    assert result["counts"] == {"previews": 0, "confirmation_attempts": 1, "runtime_audits": 0, "queue_runs": 0}
    assert result["trace"]["preview"] is None
    assert result["trace"]["runtime_audit"] is None
    assert result["trace"]["queue_runs"] == []
    assert result["links"]["confirm_attempt_details"] == ["/api/agent-worker/runtime-confirm-attempts/attempt_only"]


def test_api_returns_runtime_trace_not_found_read_only(tmp_path):
    seed_full_trace(tmp_path)
    before_previews = load_json(previews_path(tmp_path))
    before_attempts = load_json(attempts_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))
    before_runs = load_json(runs_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_missing")

    assert result["status"] == "runtime_trace_not_found"
    assert result["decision"] == "runtime_trace_graph"
    assert result["one_shot_run_id"] == "runtime_once_missing"
    assert result["counts"] == {"previews": 0, "confirmation_attempts": 0, "runtime_audits": 0, "queue_runs": 0}
    assert result["trace"] == {"preview": None, "confirmation_attempts": [], "runtime_audit": None, "queue_runs": []}
    assert result["links"] == {}
    assert load_json(previews_path(tmp_path)) == before_previews
    assert load_json(attempts_path(tmp_path)) == before_attempts
    assert load_json(audits_path(tmp_path)) == before_audits
    assert load_json(runs_path(tmp_path)) == before_runs


def test_runtime_trace_endpoint_does_not_break_detail_endpoints(tmp_path):
    seed_full_trace(tmp_path)

    trace = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_alpha")
    preview_detail = call_api(tmp_path, "/api/agent-worker/runtime-previews/preview_alpha")
    attempt_detail = call_api(tmp_path, "/api/agent-worker/runtime-confirm-attempts/attempt_alpha")
    audit_detail = call_api(tmp_path, "/api/agent-worker/runtime-audits/audit_alpha")
    run_detail = call_api(tmp_path, "/api/agent-queue/runs/run_alpha")

    assert trace["status"] == "runtime_trace_found"
    assert preview_detail["status"] == "runtime_preview_found"
    assert attempt_detail["status"] == "runtime_confirm_attempt_found"
    assert audit_detail["status"] == "runtime_audit_found"
    assert run_detail["status"] == "agent_queue_run_found"


def test_dashboard_contains_runtime_trace_actions_for_all_trace_rows():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimeTrace" in text
    assert "/api/agent-worker/runtime-traces/${encodeURIComponent(oneShotRunId)}" in text
    assert "Runtime trace graph" in text
    assert "showAgentWorkerRuntimeTrace(${JSON.stringify(preview.one_shot_run_id || '')})" in text
    assert "showAgentWorkerRuntimeTrace(${JSON.stringify(attempt.one_shot_run_id || '')})" in text
    assert "showAgentWorkerRuntimeTrace(${JSON.stringify(audit.one_shot_run_id || '')})" in text
    assert "showAgentWorkerRuntimeTrace(${JSON.stringify(run.one_shot_run_id || (run.execution_context || {}).one_shot_run_id || '')})" in text
