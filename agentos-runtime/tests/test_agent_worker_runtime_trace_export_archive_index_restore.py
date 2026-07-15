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


def write_archive(workspace: Path, archive_id: str, content: str = None, modified_epoch: int = 1_700_000_000):
    path = archive_path(workspace, archive_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = content or f"# Runtime Trace Export — {archive_id}\n\nArchived body\n"
    path.write_text(body, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def write_active_export(workspace: Path, one_shot_run_id: str, content: str = None):
    path = export_path(workspace, one_shot_run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content or f"# Runtime Trace Export — {one_shot_run_id}\n\nActive body\n", encoding="utf-8")
    return path


def test_archive_index_lists_archived_exports_newest_first_and_read_only(tmp_path):
    seed_ledgers(tmp_path)
    old_path = write_archive(tmp_path, "runtime_archived_old_trace_20260617010101", modified_epoch=1_700_000_100)
    new_path = write_archive(tmp_path, "runtime_archived_new_trace_20260617010202", modified_epoch=1_700_000_200)
    active_path = write_active_export(tmp_path, "runtime_active_not_archived")
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {
        old_path: old_path.read_text(encoding="utf-8"),
        new_path: new_path.read_text(encoding="utf-8"),
        active_path: active_path.read_text(encoding="utf-8"),
    }

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-archives?limit=1")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_archive_index"
    assert result["total"] == 2
    assert result["count"] == 1
    assert result["limit"] == 1
    assert result["links"]["archive_dir"] == "artifacts/agent-worker/runtime-traces/archive"
    assert [item["archive_id"] for item in result["archives"]] == ["runtime_archived_new_trace_20260617010202"]
    item = result["archives"][0]
    assert item["one_shot_run_id"] == "runtime_archived_new"
    assert item["filename"] == "runtime_archived_new_trace_20260617010202.md"
    assert item["title"] == "Runtime Trace Export — runtime_archived_new_trace_20260617010202"
    assert item["archive_path"] == str(new_path)
    assert item["archive_relpath"] == "artifacts/agent-worker/runtime-traces/archive/runtime_archived_new_trace_20260617010202.md"
    assert item["restore_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_archived_new_trace.md"
    assert item["links"]["restore"] == "/api/agent-worker/runtime-trace-export-archives/runtime_archived_new_trace_20260617010202/restore"
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_archive_index_missing_directory_is_empty_and_does_not_create_directories(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-archives?limit=20")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_archive_index"
    assert result["total"] == 0
    assert result["count"] == 0
    assert result["archives"] == []
    assert result["path"] == str(archive_dir(tmp_path))
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_restore_archived_export_requires_explicit_confirmation(tmp_path):
    seed_ledgers(tmp_path)
    archive_id = "runtime_restore_requires_confirm_trace_20260617020101"
    archived = write_archive(tmp_path, archive_id, "# Runtime Trace Export — runtime_restore_requires_confirm\nrestore me\n")
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = archived.read_text(encoding="utf-8")

    result = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-archives/{archive_id}/restore",
        method="POST",
        payload={"reason": "clicked_without_confirm"},
    )

    assert result["status"] == "runtime_trace_export_restore_confirmation_required"
    assert result["decision"] == "runtime_trace_export_restore"
    assert result["archive_id"] == archive_id
    assert result["one_shot_run_id"] == "runtime_restore_requires_confirm"
    assert result["will_restore"] is False
    assert result["archive_path"] == str(archived)
    assert result["restore_path"] == str(export_path(tmp_path, "runtime_restore_requires_confirm"))
    assert archived.exists()
    assert archived.read_text(encoding="utf-8") == before_content
    assert not export_path(tmp_path, "runtime_restore_requires_confirm").exists()
    assert ledger_snapshot(tmp_path) == before_ledgers


def test_restore_archived_export_artifact_only_after_confirmation(tmp_path):
    seed_ledgers(tmp_path)
    archive_id = "runtime_restore_alpha_trace_20260617030101"
    archived = write_archive(tmp_path, archive_id, "# Runtime Trace Export — runtime_restore_alpha\nrestored content\n")
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = archived.read_text(encoding="utf-8")

    result = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-archives/{archive_id}/restore",
        method="POST",
        payload={"confirm_restore": True, "reason": "operator_restore"},
    )

    restored = export_path(tmp_path, "runtime_restore_alpha")
    assert result["status"] == "runtime_trace_export_restored"
    assert result["decision"] == "runtime_trace_export_restore"
    assert result["archive_id"] == archive_id
    assert result["one_shot_run_id"] == "runtime_restore_alpha"
    assert result["reason"] == "operator_restore"
    assert result["will_restore"] is True
    assert result["artifact_only_mutation"] is True
    assert result["operational_ledgers_mutated"] is False
    assert result["archive_path"] == str(archived)
    assert result["restore_path"] == str(restored)
    assert result["restore_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_restore_alpha_trace.md"
    assert not archived.exists()
    assert restored.exists()
    assert restored.read_text(encoding="utf-8") == before_content
    assert ledger_snapshot(tmp_path) == before_ledgers

    archives = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-archives?limit=0")
    assert archive_id not in [item["archive_id"] for item in archives["archives"]]
    detail = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports/runtime_restore_alpha")
    assert detail["status"] == "runtime_trace_export_found"


def test_restore_missing_and_conflict_are_safe_artifact_only_noops(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    missing = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-archives/runtime_missing_trace_20260617040101/restore",
        method="POST",
        payload={"confirm_restore": True, "reason": "missing"},
    )
    assert missing["status"] == "runtime_trace_export_restore_not_found"
    assert missing["decision"] == "runtime_trace_export_restore"
    assert missing["will_restore"] is False
    assert missing["archive_path"] is None
    assert not exports_dir(tmp_path).exists()
    assert ledger_snapshot(tmp_path) == before_ledgers

    archive_id = "runtime_restore_conflict_trace_20260617050101"
    archived = write_archive(tmp_path, archive_id, "# Runtime Trace Export — runtime_restore_conflict\narchived content\n")
    active = write_active_export(tmp_path, "runtime_restore_conflict", "# Runtime Trace Export — runtime_restore_conflict\nactive content\n")
    before_ledgers = ledger_snapshot(tmp_path)
    before_archive = archived.read_text(encoding="utf-8")
    before_active = active.read_text(encoding="utf-8")

    conflict = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-archives/{archive_id}/restore",
        method="POST",
        payload={"confirm_restore": True, "reason": "conflict"},
    )
    assert conflict["status"] == "runtime_trace_export_restore_conflict"
    assert conflict["decision"] == "runtime_trace_export_restore"
    assert conflict["will_restore"] is False
    assert conflict["archive_path"] == str(archived)
    assert conflict["restore_path"] == str(active)
    assert archived.read_text(encoding="utf-8") == before_archive
    assert active.read_text(encoding="utf-8") == before_active
    assert ledger_snapshot(tmp_path) == before_ledgers


def test_dashboard_contains_archived_trace_exports_panel_and_restore_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "Archived Trace Exports" in text
    assert "agentWorkerRuntimeTraceExportArchives" in text
    assert "loadAgentWorkerRuntimeTraceExportArchives" in text
    assert "/api/agent-worker/runtime-trace-export-archives?limit=10" in text
    assert "restoreAgentWorkerRuntimeTraceExportArchive" in text
    assert "/api/agent-worker/runtime-trace-export-archives/${encodeURIComponent(archiveId)}/restore" in text
    assert "confirm(`Restore archived runtime trace export" in text
    assert "confirm_restore: true" in text
    assert "Restore export" in text
    assert "loadAgentWorkerRuntimeTraceExportArchives()" in text
