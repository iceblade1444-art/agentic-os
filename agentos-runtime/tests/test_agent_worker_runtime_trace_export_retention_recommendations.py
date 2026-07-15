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


def seed_exports(workspace: Path, active_count=0, archive_count=0, pruned_count=0):
    # Future mtimes keep this test focused on max-count recommendations, not age rules.
    base = 4_000_000_000
    paths = []
    for idx in range(active_count):
        paths.append(write_artifact(exports_dir(workspace) / f"runtime_active_{idx:02d}_trace.md", f"active-{idx}", base + idx))
    for idx in range(archive_count):
        paths.append(write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:02d}_trace_202606170101{idx:02d}.md", f"archive-{idx}", base + 100 + idx))
    for idx in range(pruned_count):
        paths.append(write_artifact(pruned_dir(workspace) / f"runtime_pruned_{idx:02d}_trace_202606170101{idx:02d}_pruned_202606170201{idx:02d}.md", f"pruned-{idx}", base + 200 + idx))
    return paths


def test_retention_recommendations_estimate_default_candidates_from_storage_summary_and_preview(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_exports(tmp_path, active_count=12, archive_count=52, pruned_count=3)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/recommendations")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_recommendations"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["recommended_policy"] == {"max_active": 10, "max_archived": 50, "older_than_days": 30}
    assert result["estimated_actions"] == {"archive_candidates": 2, "prune_candidates": 2, "total_candidates": 4}
    assert result["severity"] == "action_recommended"
    assert result["storage_summary"]["decision"] == "runtime_trace_export_storage_summary"
    assert result["storage_summary"]["totals"]["active_count"] == 12
    assert result["storage_summary"]["totals"]["archive_count"] == 52
    assert result["storage_summary"]["totals"]["pruned_count"] == 3
    assert result["preview"]["decision"] == "runtime_trace_export_retention_preview"
    assert result["preview"]["counts"]["archive_candidates"] == 2
    assert result["preview"]["counts"]["prune_candidates"] == 2
    assert result["rationale"]["active"] == "active_count_exceeds_recommended_max"
    assert result["rationale"]["archive"] == "archive_count_exceeds_recommended_max"
    assert result["rationale"]["pruned"] == "pruned_exports_present_review_before_delete"
    assert result["rationale"]["age"] == "older_than_days_rule_recommended"
    assert result["links"] == {
        "storage_summary": "/api/agent-worker/runtime-trace-export-storage-summary",
        "retention_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
        "active_index": "/api/agent-worker/runtime-trace-exports?limit=20",
        "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
        "pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_retention_recommendations_empty_workspace_is_monitor_only_and_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/recommendations")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_recommendations"
    assert result["severity"] == "empty"
    assert result["estimated_actions"] == {"archive_candidates": 0, "prune_candidates": 0, "total_candidates": 0}
    assert result["storage_summary"]["totals"] == {"count": 0, "total_size_bytes": 0, "active_count": 0, "archive_count": 0, "pruned_count": 0}
    assert result["rationale"]["active"] == "active_count_within_recommended_max"
    assert result["rationale"]["archive"] == "archive_count_within_recommended_max"
    assert result["rationale"]["pruned"] == "no_pruned_exports_detected"
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_retention_recommendations_small_workspace_is_monitor_only_and_preserves_preview_semantics(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_exports(tmp_path, active_count=2, archive_count=3, pruned_count=0)
    before_ledgers = ledger_snapshot(tmp_path)

    recommendations = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/recommendations")
    preview = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30")

    assert recommendations["severity"] == "monitor"
    assert recommendations["estimated_actions"] == {"archive_candidates": 0, "prune_candidates": 0, "total_candidates": 0}
    assert recommendations["preview"]["counts"] == preview["counts"]
    assert recommendations["preview"]["archive_candidates"] == preview["archive_candidates"]
    assert recommendations["preview"]["prune_candidates"] == preview["prune_candidates"]
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert all(path.exists() for path in paths)


def test_dashboard_contains_retention_recommendations_panel_and_refresh_hook():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Recommendations" in text
    assert "agentWorkerRuntimeTraceExportRetentionRecommendations" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionRecommendations" in text
    assert "/api/agent-worker/runtime-trace-export-retention/recommendations" in text
    assert "runtime_trace_export_retention_recommendations" in text
    assert "archive_candidates" in text
    assert "prune_candidates" in text
    assert "recommended_policy" in text
