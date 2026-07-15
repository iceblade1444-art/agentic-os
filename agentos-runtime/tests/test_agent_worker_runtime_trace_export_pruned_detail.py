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


def write_pruned(workspace: Path, pruned_id: str, content: str, modified_epoch: int = 1_700_000_000):
    path = pruned_path(workspace, pruned_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def test_pruned_detail_returns_bounded_redacted_preview_and_is_read_only(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_detail_trace_20260617010101_pruned_20260617020101"
    archive_id = "runtime_pruned_detail_trace_20260617010101"
    content = "\n".join([
        "# Runtime Trace Export — runtime_pruned_detail",
        "confirmation_token: SECRET_TOKEN_SHOULD_NOT_LEAK",
        "confirmation_token=ANOTHER_SECRET_SHOULD_NOT_LEAK",
        "body=" + ("x" * 180),
    ])
    path = write_pruned(tmp_path, pruned_id, content, modified_epoch=1_700_000_100)
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = path.read_text(encoding="utf-8")

    result = call_api(tmp_path, f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}?max_chars=120")

    assert result["status"] == "runtime_trace_export_pruned_found"
    assert result["decision"] == "runtime_trace_export_pruned_detail"
    assert result["pruned_id"] == pruned_id
    assert result["archive_id"] == archive_id
    assert result["one_shot_run_id"] == "runtime_pruned_detail"
    assert result["filename"] == f"{pruned_id}.md"
    assert result["title"] == "Runtime Trace Export — runtime_pruned_detail"
    assert result["pruned_path"] == str(path)
    assert result["pruned_relpath"] == f"artifacts/agent-worker/runtime-traces/pruned/{pruned_id}.md"
    assert result["restore_archive_path"] == str(archive_path(tmp_path, archive_id))
    assert result["restore_archive_relpath"] == f"artifacts/agent-worker/runtime-traces/archive/{archive_id}.md"
    assert result["line_count"] == 4
    assert result["max_chars"] == 120
    assert len(result["content_preview"]) <= 120
    assert result["truncated"] is True
    assert "SECRET_TOKEN_SHOULD_NOT_LEAK" not in result["content_preview"]
    assert "ANOTHER_SECRET_SHOULD_NOT_LEAK" not in result["content_preview"]
    assert "confirmation_token: [REDACTED]" in result["content_preview"]
    assert "confirmation_token=[REDACTED]" in result["content_preview"]
    assert result["redactions"] == ["confirmation_token"]
    assert result["links"] == {
        "pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20",
        "restore": f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
        "delete": f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete",
        "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert path.read_text(encoding="utf-8") == before_content
    assert not archive_dir(tmp_path).exists()


def test_pruned_detail_max_chars_zero_returns_full_redacted_content(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_full_trace_20260617010101_pruned_20260617020101"
    content = "# Runtime Trace Export — runtime_pruned_full\nconfirmation_token: SECRET\nbody=full-content"
    path = write_pruned(tmp_path, pruned_id, content, modified_epoch=1_700_000_100)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}?max_chars=0")

    assert result["status"] == "runtime_trace_export_pruned_found"
    assert result["max_chars"] == 0
    assert result["truncated"] is False
    assert "SECRET" not in result["content_preview"]
    assert result["content_preview"] == "# Runtime Trace Export — runtime_pruned_full\nconfirmation_token: [REDACTED]\nbody=full-content"
    assert result["content_length"] == len(result["content_preview"])
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert path.read_text(encoding="utf-8") == content


def test_pruned_detail_missing_is_explicit_and_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)
    pruned_id = "runtime_pruned_missing_detail_trace_20260617010101_pruned_20260617020101"

    result = call_api(tmp_path, f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}?max_chars=4000")

    assert result["status"] == "runtime_trace_export_pruned_not_found"
    assert result["decision"] == "runtime_trace_export_pruned_detail"
    assert result["pruned_id"] == pruned_id
    assert result["archive_id"] == "runtime_pruned_missing_detail_trace_20260617010101"
    assert result["one_shot_run_id"] == "runtime_pruned_missing_detail"
    assert result["pruned_path"] is None
    assert result["pruned_relpath"] is None
    assert result["content_preview"] == ""
    assert result["truncated"] is False
    assert result["links"] == {"pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20"}
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_pruned_detail_does_not_break_pruned_index_or_restore_delete_semantics(tmp_path):
    seed_ledgers(tmp_path)
    pruned_id = "runtime_pruned_index_survive_trace_20260617010101_pruned_20260617020101"
    content = "# Runtime Trace Export — runtime_pruned_index_survive\nconfirmation_token: SECRET"
    path = write_pruned(tmp_path, pruned_id, content, modified_epoch=1_700_000_100)

    detail = call_api(tmp_path, f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}?max_chars=100")
    index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=0")
    restore_gate = call_api(tmp_path, f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore", method="POST", payload={})
    delete_gate = call_api(tmp_path, f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete", method="POST", payload={})

    assert detail["status"] == "runtime_trace_export_pruned_found"
    assert pruned_id in [item["pruned_id"] for item in index["pruned"]]
    assert restore_gate["status"] == "runtime_trace_export_pruned_restore_confirmation_required"
    assert delete_gate["status"] == "runtime_trace_export_pruned_delete_confirmation_required"
    assert path.exists()
    assert path.read_text(encoding="utf-8") == content


def test_dashboard_contains_pruned_detail_view_action():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimeTraceExportPrunedDetail" in text
    assert "/api/agent-worker/runtime-trace-export-pruned/${encodeURIComponent(prunedId)}?max_chars=4000" in text
    assert "View pruned export" in text
    assert "Runtime trace pruned export detail" in text
    assert "restoreAgentWorkerRuntimeTraceExportPruned" in text
    assert "deleteAgentWorkerRuntimeTraceExportPruned" in text
