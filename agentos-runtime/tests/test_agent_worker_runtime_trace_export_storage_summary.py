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


def write_artifact(path: Path, content: str, modified_epoch: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def test_storage_summary_counts_sizes_timestamps_and_links_are_read_only(tmp_path):
    seed_ledgers(tmp_path)
    active_a = write_artifact(exports_dir(tmp_path) / "runtime_active_a_trace.md", "active-a", 1_700_000_000)
    active_b = write_artifact(exports_dir(tmp_path) / "runtime_active_b_trace.md", "active-b-longer", 1_700_000_300)
    archive_a = write_artifact(archive_dir(tmp_path) / "runtime_archive_a_trace_20260617010101.md", "archive-a", 1_700_000_100)
    archive_b = write_artifact(archive_dir(tmp_path) / "runtime_archive_b_trace_20260617020202.md", "archive-b-long", 1_700_000_500)
    pruned_a = write_artifact(pruned_dir(tmp_path) / "runtime_pruned_a_trace_20260617010101_pruned_20260617030303.md", "pruned-a", 1_700_000_200)
    pruned_b = write_artifact(pruned_dir(tmp_path) / "runtime_pruned_b_trace_20260617020202_pruned_20260617040404.md", "pruned-b-longest", 1_700_000_700)
    ignored_root = write_artifact(exports_dir(tmp_path) / "ignore.txt", "ignore-root", 1_700_000_800)
    ignored_archive = write_artifact(archive_dir(tmp_path) / "ignore_trace.md", "ignore-archive", 1_700_000_900)
    ignored_pruned = write_artifact(pruned_dir(tmp_path) / "ignore.md", "ignore-pruned", 1_700_001_000)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in [active_a, active_b, archive_a, archive_b, pruned_a, pruned_b, ignored_root, ignored_archive, ignored_pruned]}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-storage-summary")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_storage_summary"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["path"] == str(exports_dir(tmp_path))
    assert result["links"] == {
        "active_index": "/api/agent-worker/runtime-trace-exports?limit=20",
        "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
        "pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20",
        "retention_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30",
    }
    assert set(result["directories"].keys()) == {"active", "archive", "pruned"}

    active = result["directories"]["active"]
    assert active["exists"] is True
    assert active["pattern"] == "*_trace.md"
    assert active["count"] == 2
    assert active["total_size_bytes"] == len("active-a") + len("active-b-longer")
    assert active["oldest_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_active_a_trace.md"
    assert active["newest_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_active_b_trace.md"
    assert active["largest_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_active_b_trace.md"
    assert active["largest_size_bytes"] == len("active-b-longer")

    archive = result["directories"]["archive"]
    assert archive["exists"] is True
    assert archive["pattern"] == "*_trace_*.md"
    assert archive["count"] == 2
    assert archive["total_size_bytes"] == len("archive-a") + len("archive-b-long")
    assert archive["oldest_relpath"] == "artifacts/agent-worker/runtime-traces/archive/runtime_archive_a_trace_20260617010101.md"
    assert archive["newest_relpath"] == "artifacts/agent-worker/runtime-traces/archive/runtime_archive_b_trace_20260617020202.md"

    pruned = result["directories"]["pruned"]
    assert pruned["exists"] is True
    assert pruned["pattern"] == "*_pruned_*.md"
    assert pruned["count"] == 2
    assert pruned["total_size_bytes"] == len("pruned-a") + len("pruned-b-longest")
    assert pruned["oldest_relpath"] == "artifacts/agent-worker/runtime-traces/pruned/runtime_pruned_a_trace_20260617010101_pruned_20260617030303.md"
    assert pruned["newest_relpath"] == "artifacts/agent-worker/runtime-traces/pruned/runtime_pruned_b_trace_20260617020202_pruned_20260617040404.md"

    assert result["totals"] == {
        "count": 6,
        "total_size_bytes": len("active-a") + len("active-b-longer") + len("archive-a") + len("archive-b-long") + len("pruned-a") + len("pruned-b-longest"),
        "active_count": 2,
        "archive_count": 2,
        "pruned_count": 2,
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_storage_summary_missing_dirs_returns_zero_without_creating_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-storage-summary")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_storage_summary"
    assert result["totals"] == {"count": 0, "total_size_bytes": 0, "active_count": 0, "archive_count": 0, "pruned_count": 0}
    for name, info in result["directories"].items():
        assert name in {"active", "archive", "pruned"}
        assert info["exists"] is False
        assert info["count"] == 0
        assert info["total_size_bytes"] == 0
        assert info["oldest_modified_at"] is None
        assert info["newest_modified_at"] is None
        assert info["oldest_relpath"] is None
        assert info["newest_relpath"] is None
        assert info["largest_size_bytes"] == 0
        assert info["largest_relpath"] is None
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_storage_summary_does_not_break_existing_indexes(tmp_path):
    seed_ledgers(tmp_path)
    active = write_artifact(exports_dir(tmp_path) / "runtime_existing_trace.md", "active", 1_700_000_000)
    archive = write_artifact(archive_dir(tmp_path) / "runtime_existing_trace_20260617010101.md", "archive", 1_700_000_100)
    pruned = write_artifact(pruned_dir(tmp_path) / "runtime_existing_trace_20260617010101_pruned_20260617020202.md", "pruned", 1_700_000_200)

    summary = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-storage-summary")
    active_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports?limit=0")
    archive_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-archives?limit=0")
    pruned_index = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-pruned?limit=0")

    assert summary["totals"]["count"] == 3
    assert [item["one_shot_run_id"] for item in active_index["exports"]] == ["runtime_existing"]
    assert [item["archive_id"] for item in archive_index["archives"]] == ["runtime_existing_trace_20260617010101"]
    assert [item["pruned_id"] for item in pruned_index["pruned"]] == ["runtime_existing_trace_20260617010101_pruned_20260617020202"]
    assert active.exists() and archive.exists() and pruned.exists()


def test_dashboard_contains_storage_summary_panel_and_refresh_hook():
    text = INDEX.read_text(encoding="utf-8")
    assert "Runtime Trace Export Storage" in text
    assert "agentWorkerRuntimeTraceExportStorageSummary" in text
    assert "loadAgentWorkerRuntimeTraceExportStorageSummary" in text
    assert "/api/agent-worker/runtime-trace-export-storage-summary" in text
    assert "runtime_trace_export_storage_summary" in text
    assert "active_count" in text
    assert "archive_count" in text
    assert "pruned_count" in text
