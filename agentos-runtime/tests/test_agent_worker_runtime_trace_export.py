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


def exports_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-traces"


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def preview():
    return {
        "id": "preview_alpha",
        "preview_id": "preview_alpha",
        "one_shot_run_id": "runtime_once_alpha",
        "status": "runtime_execute_preview",
        "execution_status": "runtime_execute_completed",
        "token_status": "consumed",
        "confirmation": {"token": "token_alpha", "accepted": True},
        "runtime_audit_id": "audit_alpha",
        "queue_ids": ["queue_run_alpha", "queue_run_beta"],
        "queue_run_ids": ["run_alpha", "run_beta"],
        "execution_policy": {"manual_only": True, "confirmation_required": True},
    }


def attempt():
    return {
        "id": "attempt_alpha",
        "created_at": "2026-01-01T00:00:02",
        "status": "runtime_confirm_attempt_recorded",
        "final_status": "runtime_execute_completed",
        "runtime_called": True,
        "preflight_status": "confirmation_token_pending",
        "preview_id": "preview_alpha",
        "one_shot_run_id": "runtime_once_alpha",
        "confirmation_token": "token_alpha",
        "runtime_audit_id": "audit_alpha",
        "queue_run_ids": ["run_alpha", "run_beta"],
    }


def audit():
    return {
        "id": "audit_alpha",
        "created_at": "2026-01-01T00:00:03",
        "status": "runtime_execute_completed",
        "preview_id": "preview_alpha",
        "one_shot_run_id": "runtime_once_alpha",
        "confirmation_token": "token_alpha",
        "queue_ids": ["queue_run_alpha", "queue_run_beta"],
        "queue_run_ids": ["run_alpha", "run_beta"],
        "items": [{"queue_id": "queue_run_alpha", "run_id": "run_alpha"}, {"queue_id": "queue_run_beta", "run_id": "run_beta"}],
        "executed": 2,
        "execution_policy": {"manual_only": True, "confirmation_required": True},
    }


def queue_run(run_id: str):
    return {
        "run_id": run_id,
        "queue_id": f"queue_{run_id}",
        "project": "project_alpha",
        "task_id": run_id.replace("run_", "T"),
        "trigger": "runtime_confirm_execute",
        "status": "done",
        "runtime_preview_id": "preview_alpha",
        "one_shot_run_id": "runtime_once_alpha",
        "confirmation_token": "token_alpha",
        "artifact_path": f"C:/tmp/{run_id}.md",
        "log_path": f"C:/tmp/{run_id}.log",
        "execution_context": {
            "runtime_preview_id": "preview_alpha",
            "one_shot_run_id": "runtime_once_alpha",
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


def seed_trace(workspace: Path):
    write_json(previews_path(workspace), [preview()])
    write_json(attempts_path(workspace), [attempt()])
    write_json(audits_path(workspace), [audit()])
    write_json(runs_path(workspace), [queue_run("run_alpha"), queue_run("run_beta")])


def test_api_exports_runtime_trace_markdown_artifact_read_only_and_redacted(tmp_path):
    seed_trace(tmp_path)
    before_previews = load_json(previews_path(tmp_path))
    before_attempts = load_json(attempts_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))
    before_runs = load_json(runs_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_alpha/export")

    assert result["status"] == "runtime_trace_exported"
    assert result["decision"] == "runtime_trace_export"
    assert result["trace_status"] == "runtime_trace_found"
    assert result["one_shot_run_id"] == "runtime_once_alpha"
    assert result["preview_id"] == "preview_alpha"
    assert result["runtime_audit_id"] == "audit_alpha"
    assert result["confirm_attempt_ids"] == ["attempt_alpha"]
    assert result["queue_run_ids"] == ["run_alpha", "run_beta"]
    assert result["counts"] == {"previews": 1, "confirmation_attempts": 1, "runtime_audits": 1, "queue_runs": 2}
    assert result["redactions"] == ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"]

    artifact = Path(result["artifact_path"])
    assert artifact.name == "runtime_once_alpha_trace.md"
    assert artifact.parent == exports_dir(tmp_path)
    assert result["artifact_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_once_alpha_trace.md"
    assert artifact.exists()
    content = artifact.read_text(encoding="utf-8")
    assert "# Runtime Trace Export — runtime_once_alpha" in content
    assert "## Safety Metadata" in content
    assert "Operational ledgers mutated: false" in content
    assert "Artifact only write: true" in content
    assert "preview_alpha" in content
    assert "attempt_alpha" in content
    assert "audit_alpha" in content
    assert "run_alpha" in content and "run_beta" in content
    assert "C:/tmp/run_alpha.md" in content and "C:/tmp/run_beta.log" in content
    assert "token_alpha" not in content
    assert "[REDACTED]" in content

    assert load_json(previews_path(tmp_path)) == before_previews
    assert load_json(attempts_path(tmp_path)) == before_attempts
    assert load_json(audits_path(tmp_path)) == before_audits
    assert load_json(runs_path(tmp_path)) == before_runs


def test_api_export_not_found_does_not_write_artifact_or_mutate_ledgers(tmp_path):
    seed_trace(tmp_path)
    before_previews = load_json(previews_path(tmp_path))
    before_attempts = load_json(attempts_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))
    before_runs = load_json(runs_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_missing/export")

    assert result["status"] == "runtime_trace_export_not_found"
    assert result["decision"] == "runtime_trace_export"
    assert result["trace_status"] == "runtime_trace_not_found"
    assert result["one_shot_run_id"] == "runtime_once_missing"
    assert result["artifact_path"] is None
    assert result["artifact_relpath"] is None
    assert result["counts"] == {"previews": 0, "confirmation_attempts": 0, "runtime_audits": 0, "queue_runs": 0}
    assert not exports_dir(tmp_path).exists()
    assert load_json(previews_path(tmp_path)) == before_previews
    assert load_json(attempts_path(tmp_path)) == before_attempts
    assert load_json(audits_path(tmp_path)) == before_audits
    assert load_json(runs_path(tmp_path)) == before_runs


def test_runtime_trace_export_does_not_break_trace_graph_endpoint(tmp_path):
    seed_trace(tmp_path)

    export = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_alpha/export")
    trace = call_api(tmp_path, "/api/agent-worker/runtime-traces/runtime_once_alpha")

    assert export["status"] == "runtime_trace_exported"
    assert trace["status"] == "runtime_trace_found"
    assert trace["links"]["runtime_audit_detail"] == "/api/agent-worker/runtime-audits/audit_alpha"


def test_dashboard_contains_runtime_trace_export_actions_for_all_trace_rows():
    text = INDEX.read_text(encoding="utf-8")
    assert "exportAgentWorkerRuntimeTrace" in text
    assert "/api/agent-worker/runtime-traces/${encodeURIComponent(oneShotRunId)}/export" in text
    assert "Runtime trace export" in text
    assert "exportAgentWorkerRuntimeTrace(${JSON.stringify(preview.one_shot_run_id || '')})" in text
    assert "exportAgentWorkerRuntimeTrace(${JSON.stringify(attempt.one_shot_run_id || '')})" in text
    assert "exportAgentWorkerRuntimeTrace(${JSON.stringify(audit.one_shot_run_id || '')})" in text
    assert "exportAgentWorkerRuntimeTrace(${JSON.stringify(run.one_shot_run_id || (run.execution_context || {}).one_shot_run_id || '')})" in text
