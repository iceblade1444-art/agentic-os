import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


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


def exports_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-traces"


def archive_dir(workspace: Path):
    return exports_dir(workspace) / "archive"


def export_path(workspace: Path, one_shot_run_id: str):
    return exports_dir(workspace) / f"{one_shot_run_id}_trace.md"


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


def seed_ledgers(workspace: Path):
    write_json(previews_path(workspace), [{"preview_id": "preview_keep", "one_shot_run_id": "runtime_keep"}])
    write_json(attempts_path(workspace), [{"id": "attempt_keep", "one_shot_run_id": "runtime_keep"}])
    write_json(audits_path(workspace), [{"id": "audit_keep", "one_shot_run_id": "runtime_keep"}])
    write_json(runs_path(workspace), [{"run_id": "run_keep", "one_shot_run_id": "runtime_keep"}])


def ledger_snapshot(workspace: Path):
    return {
        "previews": load_json(previews_path(workspace)),
        "attempts": load_json(attempts_path(workspace)),
        "audits": load_json(audits_path(workspace)),
        "runs": load_json(runs_path(workspace)),
    }


def write_export(workspace: Path, one_shot_run_id: str, content: str = None, modified_epoch: int = 1_700_000_700):
    path = export_path(workspace, one_shot_run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content or f"# Runtime Trace Export — {one_shot_run_id}\n\nbody\n", encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def test_api_archives_runtime_trace_export_artifact_only_after_confirmation(tmp_path):
    seed_ledgers(tmp_path)
    one_shot_run_id = "runtime_archive_alpha"
    source = write_export(tmp_path, one_shot_run_id, "# Runtime Trace Export — runtime_archive_alpha\nsecret-free body\n")
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = source.read_text(encoding="utf-8")

    result = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}/archive",
        method="POST",
        payload={"confirm_archive": True, "reason": "operator_retention"},
    )

    assert result["status"] == "runtime_trace_export_archived"
    assert result["decision"] == "runtime_trace_export_archive"
    assert result["one_shot_run_id"] == one_shot_run_id
    assert result["reason"] == "operator_retention"
    assert result["original_artifact_path"] == str(source)
    assert result["original_artifact_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_archive_alpha_trace.md"
    assert result["artifact_only_mutation"] is True
    assert result["operational_ledgers_mutated"] is False
    assert result["will_archive"] is True
    assert result["archived_at"]
    assert result["archive_relpath"].startswith("artifacts/agent-worker/runtime-traces/archive/runtime_archive_alpha_trace_")
    assert result["archive_relpath"].endswith(".md")
    archive_path = Path(result["archive_path"])
    assert archive_path.exists()
    assert archive_path.parent == archive_dir(tmp_path)
    assert archive_path.read_text(encoding="utf-8") == before_content
    assert not source.exists()
    assert ledger_snapshot(tmp_path) == before_ledgers

    index = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports?limit=0")
    assert one_shot_run_id not in [item["one_shot_run_id"] for item in index["exports"]]
    detail = call_api(tmp_path, f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}")
    assert detail["status"] == "runtime_trace_export_not_found"


def test_api_archive_requires_explicit_confirmation_and_does_not_create_archive_dir(tmp_path):
    seed_ledgers(tmp_path)
    one_shot_run_id = "runtime_archive_requires_confirm"
    source = write_export(tmp_path, one_shot_run_id)
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = source.read_text(encoding="utf-8")

    result = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}/archive",
        method="POST",
        payload={"reason": "clicked_without_confirm"},
    )

    assert result["status"] == "runtime_trace_export_archive_confirmation_required"
    assert result["decision"] == "runtime_trace_export_archive"
    assert result["one_shot_run_id"] == one_shot_run_id
    assert result["will_archive"] is False
    assert result["archive_path"] is None
    assert result["archive_relpath"] is None
    assert result["artifact_path"] == str(source)
    assert source.exists()
    assert source.read_text(encoding="utf-8") == before_content
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not archive_dir(tmp_path).exists()


def test_api_archive_missing_export_is_safe_and_does_not_create_directories(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-exports/runtime_archive_missing/archive",
        method="POST",
        payload={"confirm_archive": True, "reason": "missing"},
    )

    assert result["status"] == "runtime_trace_export_archive_not_found"
    assert result["decision"] == "runtime_trace_export_archive"
    assert result["one_shot_run_id"] == "runtime_archive_missing"
    assert result["will_archive"] is False
    assert result["artifact_path"] is None
    assert result["archive_path"] is None
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_dashboard_contains_runtime_trace_archive_action_with_explicit_confirm():
    text = INDEX.read_text(encoding="utf-8")
    assert "archiveAgentWorkerRuntimeTraceExport" in text
    assert "/api/agent-worker/runtime-trace-exports/${encodeURIComponent(oneShotRunId)}/archive" in text
    assert "confirm(`Archive runtime trace export" in text
    assert "confirm_archive: true" in text
    assert "Archive export" in text
    assert "archiveAgentWorkerRuntimeTraceExport(${JSON.stringify(item.one_shot_run_id || '')})" in text
