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


def pruned_path(workspace: Path, pruned_id: str):
    return pruned_dir(workspace) / f"{pruned_id}.md"


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


def write_pruned(workspace: Path, pruned_id: str, content: str = None, modified_epoch: int = 1_700_000_000):
    path = pruned_path(workspace, pruned_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content or f"# Runtime Trace Export — {pruned_id}\n\nPruned body\n", encoding="utf-8")
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


def test_pruned_index_lists_newest_first_and_is_read_only(tmp_path):
    seed_ledgers(tmp_path)
    pruned_old_id = "runtime_pruned_old_trace_20260617010101_pruned_20260617020101"
    pruned_new_id = "runtime_pruned_new_trace_20260617010102_pruned_20260617020102"
    old_path = write_pruned(tmp_path, pruned_old_id, "old pruned", modified_epoch=1_700_000_100)
    new_path = write_pruned(tmp_path, pruned_new_id, "new pruned", modified_epoch=1_700_000_300)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = file_snapshot([old_path, new_path])

    limited = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=1")
    full = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=0")

    assert limited["status"] == "ok"
    assert limited["decision"] == "runtime_trace_export_pruned_index"
    assert limited["path"] == str(pruned_dir(tmp_path))
    assert limited["total"] == 2
    assert limited["count"] == 1
    assert limited["limit"] == 1
    assert [item["pruned_id"] for item in limited["pruned"]] == [pruned_new_id]
    entry = limited["pruned"][0]
    assert entry["archive_id"] == "runtime_pruned_new_trace_20260617010102"
    assert entry["one_shot_run_id"] == "runtime_pruned_new"
    assert entry["filename"] == f"{pruned_new_id}.md"
    assert entry["pruned_path"] == str(new_path)
    assert entry["pruned_relpath"] == f"artifacts/agent-worker/runtime-traces/pruned/{pruned_new_id}.md"
    assert entry["restore_archive_path"] == str(archive_path(tmp_path, "runtime_pruned_new_trace_20260617010102"))
    assert entry["restore_archive_relpath"] == "artifacts/agent-worker/runtime-traces/archive/runtime_pruned_new_trace_20260617010102.md"
    assert entry["links"]["restore"] == f"/api/agent-worker/runtime-trace-export-pruned/{pruned_new_id}/restore"
    assert entry["links"]["delete"] == f"/api/agent-worker/runtime-trace-export-pruned/{pruned_new_id}/delete"
    assert [item["pruned_id"] for item in full["pruned"]] == [pruned_new_id, pruned_old_id]
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert file_snapshot([old_path, new_path]) == before_files
    assert not archive_dir(tmp_path).exists()


def test_pruned_index_missing_directory_is_empty_and_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=20")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_pruned_index"
    assert result["path"] == str(pruned_dir(tmp_path))
    assert result["total"] == 0
    assert result["count"] == 0
    assert result["pruned"] == []
    assert result["links"]["pruned_dir"] == "artifacts/agent-worker/runtime-traces/pruned"
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_pruned_restore_requires_confirmation_then_moves_artifact_back_to_archive_only(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_restore_trace_20260617010101_pruned_20260617020101"
    archive_id = "runtime_pruned_restore_trace_20260617010101"
    source = write_pruned(tmp_path, pruned_id, "restore me", modified_epoch=1_700_000_100)
    restore_target = archive_path(tmp_path, archive_id)
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = source.read_text(encoding="utf-8")

    no_confirm = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
        method="POST",
        payload={"reason": "clicked_without_confirm"},
    )

    assert no_confirm["status"] == "runtime_trace_export_pruned_restore_confirmation_required"
    assert no_confirm["decision"] == "runtime_trace_export_pruned_restore"
    assert no_confirm["will_restore"] is False
    assert no_confirm["pruned_id"] == pruned_id
    assert no_confirm["archive_id"] == archive_id
    assert no_confirm["restore_archive_path"] == str(restore_target)
    assert source.exists()
    assert not restore_target.exists()
    assert ledger_snapshot(tmp_path) == before_ledgers

    restored = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
        method="POST",
        payload={"confirm_restore": True, "reason": "operator_restore_pruned"},
    )

    assert restored["status"] == "runtime_trace_export_pruned_restored"
    assert restored["decision"] == "runtime_trace_export_pruned_restore"
    assert restored["will_restore"] is True
    assert restored["reason"] == "operator_restore_pruned"
    assert restored["artifact_only_mutation"] is True
    assert restored["operational_ledgers_mutated"] is False
    assert restored["pruned_relpath"] == f"artifacts/agent-worker/runtime-traces/pruned/{pruned_id}.md"
    assert restored["restore_archive_relpath"] == f"artifacts/agent-worker/runtime-traces/archive/{archive_id}.md"
    assert not source.exists()
    assert restore_target.exists()
    assert restore_target.read_text(encoding="utf-8") == before_content
    assert ledger_snapshot(tmp_path) == before_ledgers

    pruned_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=0")
    assert pruned_id not in [item["pruned_id"] for item in pruned_index["pruned"]]
    archive_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-archives?limit=0")
    assert archive_id in [item["archive_id"] for item in archive_index["archives"]]


def test_pruned_restore_never_overwrites_existing_archive(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_conflict_trace_20260617010101_pruned_20260617020101"
    archive_id = "runtime_pruned_conflict_trace_20260617010101"
    source = write_pruned(tmp_path, pruned_id, "pruned conflict", modified_epoch=1_700_000_100)
    existing = write_archive(tmp_path, archive_id, "existing archive", modified_epoch=1_700_000_300)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
        method="POST",
        payload={"confirm_restore": True, "reason": "would_overwrite"},
    )

    assert result["status"] == "runtime_trace_export_pruned_restore_conflict"
    assert result["decision"] == "runtime_trace_export_pruned_restore"
    assert result["will_restore"] is False
    assert source.exists()
    assert source.read_text(encoding="utf-8") == "pruned conflict"
    assert existing.exists()
    assert existing.read_text(encoding="utf-8") == "existing archive"
    assert ledger_snapshot(tmp_path) == before_ledgers


def test_pruned_delete_requires_strong_phrase_then_deletes_selected_artifact_only(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_delete_trace_20260617010101_pruned_20260617020101"
    source = write_pruned(tmp_path, pruned_id, "delete me", modified_epoch=1_700_000_100)
    before_ledgers = ledger_snapshot(tmp_path)

    no_phrase = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete",
        method="POST",
        payload={"confirm_delete": True, "confirmation_phrase": "wrong", "reason": "operator_delete"},
    )

    assert no_phrase["status"] == "runtime_trace_export_pruned_delete_confirmation_required"
    assert no_phrase["decision"] == "runtime_trace_export_pruned_delete"
    assert no_phrase["will_delete"] is False
    assert no_phrase["required_phrase"] == f"DELETE PRUNED EXPORT {pruned_id}"
    assert source.exists()
    assert source.read_text(encoding="utf-8") == "delete me"
    assert ledger_snapshot(tmp_path) == before_ledgers

    deleted = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete",
        method="POST",
        payload={"confirm_delete": True, "confirmation_phrase": f"DELETE PRUNED EXPORT {pruned_id}", "reason": "operator_delete"},
    )

    assert deleted["status"] == "runtime_trace_export_pruned_deleted"
    assert deleted["decision"] == "runtime_trace_export_pruned_delete"
    assert deleted["will_delete"] is True
    assert deleted["permanently_deleted"] is True
    assert deleted["reason"] == "operator_delete"
    assert deleted["pruned_relpath"] == f"artifacts/agent-worker/runtime-traces/pruned/{pruned_id}.md"
    assert deleted["artifact_only_mutation"] is True
    assert deleted["operational_ledgers_mutated"] is False
    assert not source.exists()
    assert ledger_snapshot(tmp_path) == before_ledgers

    pruned_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=0")
    assert pruned_id not in [item["pruned_id"] for item in pruned_index["pruned"]]


def test_pruned_restore_and_delete_missing_return_explicit_not_found(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_missing_trace_20260617010101_pruned_20260617020101"

    restore = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
        method="POST",
        payload={"confirm_restore": True},
    )
    delete = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete",
        method="POST",
        payload={"confirm_delete": True, "confirmation_phrase": f"DELETE PRUNED EXPORT {pruned_id}"},
    )

    assert restore["status"] == "runtime_trace_export_pruned_restore_not_found"
    assert restore["decision"] == "runtime_trace_export_pruned_restore"
    assert restore["will_restore"] is False
    assert restore["pruned_path"] is None
    assert delete["status"] == "runtime_trace_export_pruned_delete_not_found"
    assert delete["decision"] == "runtime_trace_export_pruned_delete"
    assert delete["will_delete"] is False
    assert delete["pruned_path"] is None
    assert not exports_dir(tmp_path).exists()


def test_dashboard_contains_pruned_trace_export_controls_and_refresh_loader():
    text = INDEX.read_text(encoding="utf-8")
    assert "Pruned Trace Exports" in text
    assert "agentWorkerRuntimeTraceExportPruned" in text
    assert "loadAgentWorkerRuntimeTraceExportPruned" in text
    assert "restoreAgentWorkerRuntimeTraceExportPruned" in text
    assert "deleteAgentWorkerRuntimeTraceExportPruned" in text
    assert "/api/agent-worker/runtime-trace-export-pruned?limit=10" in text
    assert "/api/agent-worker/runtime-trace-export-pruned/${encodeURIComponent(prunedId)}/restore" in text
    assert "/api/agent-worker/runtime-trace-export-pruned/${encodeURIComponent(prunedId)}/delete" in text
    assert "confirm_restore: true" in text
    assert "confirm_delete: true" in text
    assert "DELETE PRUNED EXPORT" in text
    assert "Refresh pruned exports" in text
    assert "loadAgentWorkerRuntimeTraceExportPruned()" in text
