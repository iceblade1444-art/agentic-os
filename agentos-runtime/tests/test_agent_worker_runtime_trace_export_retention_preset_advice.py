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
    # Future mtimes keep this test focused on max-count preset advice, not age rules.
    base = 4_000_000_000
    paths = []
    for idx in range(active_count):
        paths.append(write_artifact(exports_dir(workspace) / f"runtime_active_{idx:02d}_trace.md", 10 + idx, base + idx))
    for idx in range(archive_count):
        paths.append(write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:02d}_trace_202606170303{idx:02d}.md", 20 + idx, base + 100 + idx))
    return paths


def guidance_by_name(result):
    return {item["name"]: item for item in result["preset_guidance"]}


def test_preset_advice_recommends_standard_for_balanced_default_cleanup(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=12, archive_count=52)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["recommended_preset"] == "standard"
    assert result["recommended_policy"] == EXPECTED_POLICIES["standard"]
    assert result["recommended_action"] == "review_retention_preview"
    assert result["severity"] == "action_recommended"
    assert result["reason_codes"] == [
        "preset_impact_matrix_evaluated",
        "standard_has_candidates_balanced_default",
        "retention_apply_requires_confirm_retention_true",
    ]
    assert result["recommended_impact"]["name"] == "standard"
    assert result["recommended_impact"]["archive_candidate_count"] == 2
    assert result["recommended_impact"]["prune_candidate_count"] == 2
    assert result["impact_matrix"]["decision"] == "runtime_trace_export_retention_preset_impact"
    guidance = guidance_by_name(result)
    assert guidance["conservative"]["guidance_level"] == "monitor"
    assert guidance["standard"]["guidance_level"] == "recommended"
    assert guidance["aggressive"]["guidance_level"] == "higher_churn_available"
    assert result["operator_next_steps"] == [
        "review_standard_impact_detail",
        "preview_standard_retention",
        "apply_retention_requires_confirm_retention_true",
    ]
    assert result["safety"] == {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    assert result["links"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
        "preset_impact": "/api/agent-worker/runtime-trace-export-retention/preset-impact",
        "recommended_impact_detail": "/api/agent-worker/runtime-trace-export-retention/preset-impact/standard",
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_preset_advice_recommends_conservative_when_safest_preset_has_candidates(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice")

    assert result["recommended_preset"] == "conservative"
    assert result["recommended_policy"] == EXPECTED_POLICIES["conservative"]
    assert result["severity"] == "action_recommended"
    assert result["reason_codes"] == [
        "preset_impact_matrix_evaluated",
        "conservative_has_candidates_safest_action",
        "retention_apply_requires_confirm_retention_true",
    ]
    assert result["recommended_impact"]["archive_candidate_count"] == 5
    assert result["recommended_impact"]["prune_candidate_count"] == 10
    guidance = guidance_by_name(result)
    assert guidance["conservative"]["guidance_level"] == "recommended"
    assert guidance["standard"]["guidance_level"] == "more_aggressive_than_recommended"
    assert guidance["aggressive"]["guidance_level"] == "higher_churn_available"
    assert result["operator_next_steps"] == [
        "review_conservative_impact_detail",
        "preview_conservative_retention",
        "apply_retention_requires_confirm_retention_true",
    ]
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_preset_advice_empty_workspace_is_monitor_read_only_and_does_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice"
    assert result["recommended_preset"] == "standard"
    assert result["recommended_action"] == "monitor_storage"
    assert result["severity"] == "empty"
    assert result["reason_codes"] == [
        "preset_impact_matrix_evaluated",
        "no_runtime_trace_exports_detected",
        "monitor_storage_summary",
    ]
    assert result["recommended_impact"]["total_candidate_count"] == 0
    assert all(item["guidance_level"] == "monitor" for item in result["preset_guidance"])
    assert result["operator_next_steps"] == [
        "monitor_storage_summary",
        "review_preset_impact_if_disk_pressure_changes",
    ]
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_dashboard_contains_preset_advice_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdvice" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdvice" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice" in text
    assert "runtime_trace_export_retention_preset_advice" in text
    assert "recommended_preset" in text
    assert "reason_codes" in text
    assert "operator_next_steps" in text
