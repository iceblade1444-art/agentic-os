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


def pruned_dir(workspace: Path):
    return exports_dir(workspace) / "pruned"


def active_export_path(workspace: Path, one_shot_run_id: str):
    return exports_dir(workspace) / f"{one_shot_run_id}_trace.md"


def archive_path(workspace: Path, archive_id: str):
    return archive_dir(workspace) / f"{archive_id}.md"


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


def write_active_export(workspace: Path, one_shot_run_id: str, content: str = None, modified_epoch: int = 1_700_000_000):
    path = active_export_path(workspace, one_shot_run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content or f"# Runtime Trace Export — {one_shot_run_id}\n\nActive body\n", encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def write_archive(workspace: Path, archive_id: str, content: str = None, modified_epoch: int = 1_700_000_000):
    path = archive_path(workspace, archive_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content or f"# Runtime Trace Export — {archive_id}\n\nArchived body\n", encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def file_snapshot(paths):
    return {path: path.read_text(encoding="utf-8") for path in paths if path.exists()}


def test_retention_preview_selects_oldest_active_and_archived_candidates_read_only(tmp_path):
    seed_ledgers(tmp_path)
    active_old = write_active_export(tmp_path, "runtime_retention_active_old", "old active", modified_epoch=1_700_000_100)
    active_new = write_active_export(tmp_path, "runtime_retention_active_new", "new active", modified_epoch=1_700_000_300)
    archived_old = write_archive(tmp_path, "runtime_retention_archived_old_trace_20260617010101", "old archived", modified_epoch=1_700_000_110)
    archived_new = write_archive(tmp_path, "runtime_retention_archived_new_trace_20260617010202", "new archived", modified_epoch=1_700_000_310)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = file_snapshot([active_old, active_new, archived_old, archived_new])

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preview?max_active=1&max_archived=1")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preview"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["policy"] == {"max_active": 1, "max_archived": 1, "older_than_days": None}
    assert result["counts"] == {"active_total": 2, "archived_total": 2, "archive_candidates": 1, "prune_candidates": 1}
    assert [item["one_shot_run_id"] for item in result["archive_candidates"]] == ["runtime_retention_active_old"]
    assert result["archive_candidates"][0]["artifact_path"] == str(active_old)
    assert result["archive_candidates"][0]["artifact_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_retention_active_old_trace.md"
    assert result["archive_candidates"][0]["planned_archive_relpath"].startswith("artifacts/agent-worker/runtime-traces/archive/runtime_retention_active_old_trace_")
    assert [item["archive_id"] for item in result["prune_candidates"]] == ["runtime_retention_archived_old_trace_20260617010101"]
    assert result["prune_candidates"][0]["archive_path"] == str(archived_old)
    assert result["prune_candidates"][0]["planned_pruned_relpath"].startswith("artifacts/agent-worker/runtime-traces/pruned/runtime_retention_archived_old_trace_20260617010101_pruned_")
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert file_snapshot([active_old, active_new, archived_old, archived_new]) == before_files
    assert not pruned_dir(tmp_path).exists()


def test_retention_preview_missing_directories_is_empty_and_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preview?max_active=2&max_archived=3&older_than_days=30")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preview"
    assert result["counts"] == {"active_total": 0, "archived_total": 0, "archive_candidates": 0, "prune_candidates": 0}
    assert result["archive_candidates"] == []
    assert result["prune_candidates"] == []
    assert result["policy"] == {"max_active": 2, "max_archived": 3, "older_than_days": 30}
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_retention_apply_requires_explicit_confirmation_and_is_noop(tmp_path):
    seed_ledgers(tmp_path)
    active_old = write_active_export(tmp_path, "runtime_retention_no_confirm_old", "old active", modified_epoch=1_700_000_100)
    active_new = write_active_export(tmp_path, "runtime_retention_no_confirm_new", "new active", modified_epoch=1_700_000_300)
    archived_old = write_archive(tmp_path, "runtime_retention_no_confirm_archived_old_trace_20260617010101", "old archived", modified_epoch=1_700_000_110)
    archived_new = write_archive(tmp_path, "runtime_retention_no_confirm_archived_new_trace_20260617010202", "new archived", modified_epoch=1_700_000_310)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = file_snapshot([active_old, active_new, archived_old, archived_new])

    result = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/apply",
        method="POST",
        payload={"max_active": 1, "max_archived": 1, "reason": "clicked_without_confirm"},
    )

    assert result["status"] == "runtime_trace_export_retention_confirmation_required"
    assert result["decision"] == "runtime_trace_export_retention_apply"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["preview"]["counts"]["archive_candidates"] == 1
    assert result["preview"]["counts"]["prune_candidates"] == 1
    assert result["archived"] == []
    assert result["pruned"] == []
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert file_snapshot([active_old, active_new, archived_old, archived_new]) == before_files
    assert not pruned_dir(tmp_path).exists()


def test_retention_apply_archives_active_and_prunes_archived_artifacts_only(tmp_path):
    seed_ledgers(tmp_path)
    active_old = write_active_export(tmp_path, "runtime_retention_apply_active_old", "old active", modified_epoch=1_700_000_100)
    active_new = write_active_export(tmp_path, "runtime_retention_apply_active_new", "new active", modified_epoch=1_700_000_300)
    archived_old = write_archive(tmp_path, "runtime_retention_apply_archived_old_trace_20260617010101", "old archived", modified_epoch=1_700_000_110)
    archived_new = write_archive(tmp_path, "runtime_retention_apply_archived_new_trace_20260617010202", "new archived", modified_epoch=1_700_000_310)
    before_ledgers = ledger_snapshot(tmp_path)
    old_active_content = active_old.read_text(encoding="utf-8")
    old_archived_content = archived_old.read_text(encoding="utf-8")
    new_active_content = active_new.read_text(encoding="utf-8")
    new_archived_content = archived_new.read_text(encoding="utf-8")

    result = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/apply",
        method="POST",
        payload={"max_active": 1, "max_archived": 1, "confirm_retention": True, "reason": "operator_retention"},
    )

    assert result["status"] == "runtime_trace_export_retention_applied"
    assert result["decision"] == "runtime_trace_export_retention_apply"
    assert result["dry_run"] is False
    assert result["will_apply"] is True
    assert result["reason"] == "operator_retention"
    assert result["artifact_only_mutation"] is True
    assert result["operational_ledgers_mutated"] is False
    assert result["counts"] == {"archived": 1, "pruned": 1}
    assert len(result["archived"]) == 1
    assert len(result["pruned"]) == 1

    archived_entry = result["archived"][0]
    pruned_entry = result["pruned"][0]
    assert archived_entry["one_shot_run_id"] == "runtime_retention_apply_active_old"
    assert archived_entry["source_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_retention_apply_active_old_trace.md"
    assert archived_entry["archive_relpath"].startswith("artifacts/agent-worker/runtime-traces/archive/runtime_retention_apply_active_old_trace_")
    assert pruned_entry["archive_id"] == "runtime_retention_apply_archived_old_trace_20260617010101"
    assert pruned_entry["source_relpath"] == "artifacts/agent-worker/runtime-traces/archive/runtime_retention_apply_archived_old_trace_20260617010101.md"
    assert pruned_entry["pruned_relpath"].startswith("artifacts/agent-worker/runtime-traces/pruned/runtime_retention_apply_archived_old_trace_20260617010101_pruned_")

    moved_archive = Path(archived_entry["archive_path"])
    moved_pruned = Path(pruned_entry["pruned_path"])
    assert not active_old.exists()
    assert moved_archive.exists()
    assert moved_archive.read_text(encoding="utf-8") == old_active_content
    assert active_new.exists()
    assert active_new.read_text(encoding="utf-8") == new_active_content
    assert not archived_old.exists()
    assert moved_pruned.exists()
    assert moved_pruned.read_text(encoding="utf-8") == old_archived_content
    assert archived_new.exists()
    assert archived_new.read_text(encoding="utf-8") == new_archived_content
    assert ledger_snapshot(tmp_path) == before_ledgers

    active_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports?limit=0")
    assert "runtime_retention_apply_active_old" not in [item["one_shot_run_id"] for item in active_index["exports"]]
    archive_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-archives?limit=0")
    archive_ids = [item["archive_id"] for item in archive_index["archives"]]
    assert "runtime_retention_apply_archived_old_trace_20260617010101" not in archive_ids
    assert any(item["one_shot_run_id"] == "runtime_retention_apply_active_old" for item in archive_index["archives"])


def test_dashboard_contains_retention_preview_apply_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "Runtime Trace Export Retention" in text
    assert "agentWorkerRuntimeTraceExportRetention" in text
    assert "previewAgentWorkerRuntimeTraceExportRetention" in text
    assert "applyAgentWorkerRuntimeTraceExportRetention" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preview" in text
    assert "/api/agent-worker/runtime-trace-export-retention/apply" in text
    assert "confirm(`Apply runtime trace export retention" in text
    assert "confirm_retention: true" in text
    assert "Retention preview" in text
    assert "Apply retention" in text
