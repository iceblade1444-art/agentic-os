import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


EXPECTED_POLICIES = {
    "conservative": {"max_active": 25, "max_archived": 100, "older_than_days": 90},
    "standard": {"max_active": 10, "max_archived": 50, "older_than_days": 30},
    "aggressive": {"max_active": 3, "max_archived": 10, "older_than_days": 7},
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


def exports_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-traces"


def archive_dir(workspace: Path):
    return exports_dir(workspace) / "archive"


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


def write_artifact(path: Path, size: int, modified_epoch: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x" * size, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def seed_sized_exports(workspace: Path, active_count=0, archive_count=0):
    # Future mtimes keep this test focused on max-count preset impact, not age rules.
    base = 4_000_000_000
    paths = []
    active_sizes = {}
    archive_sizes = {}
    for idx in range(active_count):
        size = 10 + idx
        path = write_artifact(exports_dir(workspace) / f"runtime_active_{idx:02d}_trace.md", size, base + idx)
        paths.append(path)
        active_sizes[idx] = size
    for idx in range(archive_count):
        size = 20 + idx
        path = write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:02d}_trace_202606170101{idx:02d}.md", size, base + 100 + idx)
        paths.append(path)
        archive_sizes[idx] = size
    return paths, active_sizes, archive_sizes


def by_name(result):
    return {impact["name"]: impact for impact in result["impacts"]}


def test_preset_impact_matrix_compares_candidate_counts_and_bytes_without_mutation(tmp_path):
    seed_ledgers(tmp_path)
    paths, active_sizes, archive_sizes = seed_sized_exports(tmp_path, active_count=12, archive_count=52)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-impact")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_impact"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["default_preset"] == "standard"
    assert result["preset_names"] == ["conservative", "standard", "aggressive"]
    assert result["matrix_columns"] == [
        "preset",
        "max_active",
        "max_archived",
        "older_than_days",
        "archive_candidates",
        "prune_candidates",
        "total_candidates",
        "archive_candidate_size_bytes",
        "prune_candidate_size_bytes",
        "total_candidate_size_bytes",
    ]
    assert result["storage_summary"]["decision"] == "runtime_trace_export_storage_summary"
    assert result["storage_summary"]["totals"]["active_count"] == 12
    assert result["storage_summary"]["totals"]["archive_count"] == 52
    impacts = by_name(result)
    assert {name: impact["policy"] for name, impact in impacts.items()} == EXPECTED_POLICIES

    assert impacts["conservative"]["counts"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 0, "prune_candidates": 0}
    assert impacts["conservative"]["archive_candidate_size_bytes"] == 0
    assert impacts["conservative"]["prune_candidate_size_bytes"] == 0
    assert impacts["conservative"]["total_candidate_size_bytes"] == 0

    assert impacts["standard"]["counts"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 2, "prune_candidates": 2}
    assert impacts["standard"]["archive_candidate_size_bytes"] == active_sizes[0] + active_sizes[1]
    assert impacts["standard"]["prune_candidate_size_bytes"] == archive_sizes[0] + archive_sizes[1]
    assert impacts["standard"]["total_candidate_size_bytes"] == active_sizes[0] + active_sizes[1] + archive_sizes[0] + archive_sizes[1]

    assert impacts["aggressive"]["counts"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 9, "prune_candidates": 42}
    assert impacts["aggressive"]["archive_candidate_size_bytes"] == sum(active_sizes[idx] for idx in range(9))
    assert impacts["aggressive"]["prune_candidate_size_bytes"] == sum(archive_sizes[idx] for idx in range(42))
    assert impacts["aggressive"]["total_candidate_size_bytes"] == sum(active_sizes[idx] for idx in range(9)) + sum(archive_sizes[idx] for idx in range(42))
    assert impacts["aggressive"]["highest_impact"] is True
    assert impacts["conservative"]["highest_impact"] is False

    assert result["totals"] == {
        "presets": 3,
        "max_archive_candidates": 9,
        "max_prune_candidates": 42,
        "max_total_candidates": 51,
        "max_total_candidate_size_bytes": impacts["aggressive"]["total_candidate_size_bytes"],
    }
    assert result["links"] == {
        "presets": "/api/agent-worker/runtime-trace-export-retention/presets",
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/recommended-preview",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_preset_impact_empty_workspace_is_read_only_and_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-impact")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_impact"
    assert result["storage_summary"]["totals"] == {"count": 0, "total_size_bytes": 0, "active_count": 0, "archive_count": 0, "pruned_count": 0}
    for impact in result["impacts"]:
        assert impact["counts"] == {"active_total": 0, "archived_total": 0, "archive_candidates": 0, "prune_candidates": 0}
        assert impact["archive_candidate_size_bytes"] == 0
        assert impact["prune_candidate_size_bytes"] == 0
        assert impact["total_candidate_size_bytes"] == 0
        assert impact["highest_impact"] is False
    assert result["totals"] == {
        "presets": 3,
        "max_archive_candidates": 0,
        "max_prune_candidates": 0,
        "max_total_candidates": 0,
        "max_total_candidate_size_bytes": 0,
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_preset_impact_embeds_preview_urls_and_preview_statuses(tmp_path):
    seed_ledgers(tmp_path)
    seed_sized_exports(tmp_path, active_count=4, archive_count=12)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-impact")
    presets = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/presets")
    preset_urls = {preset["name"]: preset["preview_url"] for preset in presets["presets"]}

    for impact in result["impacts"]:
        assert impact["preview_url"] == preset_urls[impact["name"]]
        assert impact["preview"]["status"] == "ok"
        assert impact["preview"]["decision"] == "runtime_trace_export_retention_preview"
        assert impact["preview"]["policy"] == impact["policy"]
        assert impact["dry_run"] is True
        assert impact["will_apply"] is False


def test_dashboard_contains_preset_impact_table_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Impact" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetImpact" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetImpact" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-impact" in text
    assert "runtime_trace_export_retention_preset_impact" in text
    assert "archive_candidate_size_bytes" in text
    assert "prune_candidate_size_bytes" in text
    assert "highest_impact" in text


def test_preset_impact_detail_returns_one_preset_with_full_candidates_and_no_mutation(tmp_path):
    seed_ledgers(tmp_path)
    paths, active_sizes, archive_sizes = seed_sized_exports(tmp_path, active_count=12, archive_count=52)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-impact/aggressive")

    assert result["status"] == "runtime_trace_export_retention_preset_impact_found"
    assert result["decision"] == "runtime_trace_export_retention_preset_impact_detail"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["preset_name"] == "aggressive"
    assert result["name"] == "aggressive"
    assert result["policy"] == EXPECTED_POLICIES["aggressive"]
    assert result["preview_url"] == "/api/agent-worker/runtime-trace-export-retention/preview?max_active=3&max_archived=10&older_than_days=7"
    assert result["preview"]["decision"] == "runtime_trace_export_retention_preview"
    assert result["preview"]["policy"] == EXPECTED_POLICIES["aggressive"]
    assert result["counts"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 9, "prune_candidates": 42}
    assert result["archive_candidate_count"] == 9
    assert result["prune_candidate_count"] == 42
    assert result["total_candidate_count"] == 51
    assert result["candidates"]["archive_candidates"] == result["preview"]["archive_candidates"]
    assert result["candidates"]["prune_candidates"] == result["preview"]["prune_candidates"]
    assert len(result["candidates"]["archive_candidates"]) == 9
    assert len(result["candidates"]["prune_candidates"]) == 42
    assert result["archive_candidate_size_bytes"] == sum(active_sizes[idx] for idx in range(9))
    assert result["prune_candidate_size_bytes"] == sum(archive_sizes[idx] for idx in range(42))
    assert result["total_candidate_size_bytes"] == sum(active_sizes[idx] for idx in range(9)) + sum(archive_sizes[idx] for idx in range(42))
    assert result["links"] == {
        "preset_impact": "/api/agent-worker/runtime-trace-export-retention/preset-impact",
        "presets": "/api/agent-worker/runtime-trace-export-retention/presets",
        "preview": result["preview_url"],
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/recommended-preview",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_preset_impact_detail_for_empty_workspace_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-impact/standard")

    assert result["status"] == "runtime_trace_export_retention_preset_impact_found"
    assert result["decision"] == "runtime_trace_export_retention_preset_impact_detail"
    assert result["preset_name"] == "standard"
    assert result["counts"] == {"active_total": 0, "archived_total": 0, "archive_candidates": 0, "prune_candidates": 0}
    assert result["candidates"] == {"archive_candidates": [], "prune_candidates": []}
    assert result["archive_candidate_size_bytes"] == 0
    assert result["prune_candidate_size_bytes"] == 0
    assert result["total_candidate_size_bytes"] == 0
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_preset_impact_detail_unknown_preset_is_read_only_not_found(tmp_path):
    seed_ledgers(tmp_path)
    paths, _, _ = seed_sized_exports(tmp_path, active_count=2, archive_count=2)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-impact/unknown")

    assert result["status"] == "runtime_trace_export_retention_preset_impact_not_found"
    assert result["decision"] == "runtime_trace_export_retention_preset_impact_detail"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["preset_name"] == "unknown"
    assert result["impact"] is None
    assert result["candidates"] == {"archive_candidates": [], "prune_candidates": []}
    assert result["links"] == {
        "preset_impact": "/api/agent-worker/runtime-trace-export-retention/preset-impact",
        "presets": "/api/agent-worker/runtime-trace-export-retention/presets",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_dashboard_contains_preset_impact_detail_action_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "View impact" in text
    assert "showAgentWorkerRuntimeTraceExportRetentionPresetImpactDetail" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-impact/${encodeURIComponent(name)}" in text
    assert "runtime_trace_export_retention_preset_impact_detail" in text
    assert "archive_candidates" in text
    assert "prune_candidates" in text
