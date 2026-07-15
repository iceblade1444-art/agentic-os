import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"

CONSERVATIVE_POLICY = {"max_active": 25, "max_archived": 100, "older_than_days": 90}
STANDARD_POLICY = {"max_active": 10, "max_archived": 50, "older_than_days": 30}


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
    base = 4_000_000_000
    paths = []
    for idx in range(active_count):
        paths.append(write_artifact(exports_dir(workspace) / f"runtime_active_{idx:02d}_trace.md", 10 + idx, base + idx))
    for idx in range(archive_count):
        paths.append(write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:03d}_trace_202606170808{idx:03d}.md", 20 + idx, base + 100 + idx))
    return paths


def test_preset_advice_checklist_progress_reports_pending_informational_and_blocked_without_writes(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_progress"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["checklist"]["decision"] == "runtime_trace_export_retention_preset_advice_checklist"
    assert result["checklist"]["checklist"]["recommended_preset"] == "conservative"

    progress = result["progress"]
    assert progress["recommended_preset"] == "conservative"
    assert progress["recommended_policy"] == CONSERVATIVE_POLICY
    assert progress["recommended_action"] == "review_retention_preview"
    assert progress["severity"] == "action_recommended"
    assert progress["operator_state"] == "pending_operator_review"
    assert progress["next_required_step"] == "review_recommended_impact_detail"
    assert progress["apply_allowed"] is False
    assert progress["can_apply_now"] is False
    assert progress["review_complete"] is False
    assert progress["total_items"] == 4
    assert progress["status_counts"] == {
        "informational": 1,
        "pending_operator_review": 2,
        "blocked_behind_explicit_confirmation": 1,
        "not_recommended": 0,
    }
    assert [item["id"] for item in progress["items"]] == [
        "review_recommended_impact_detail",
        "preview_recommended_retention_policy",
        "verify_safety_gates",
        "confirm_retention_apply_manually",
    ]
    assert [item["progress_status"] for item in progress["items"]] == [
        "pending_operator_review",
        "pending_operator_review",
        "informational",
        "blocked_behind_explicit_confirmation",
    ]
    assert progress["items"][0]["operator_action"] == "open_endpoint_and_review_output"
    assert progress["items"][0]["endpoint"] == "/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative"
    assert progress["items"][0]["blocks_apply"] is True
    assert progress["items"][1]["endpoint"] == "/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90"
    assert progress["items"][2]["operator_action"] == "read_safety_gates"
    assert progress["items"][2]["gates"] == [
        "dry_run_only",
        "retention_apply_requires_confirm_retention_true",
        "no_history_writes",
        "no_operational_ledger_mutation",
    ]
    assert progress["items"][2]["blocks_apply"] is False
    assert progress["items"][3]["operator_action"] == "do_not_apply_until_review_complete_and_confirm_retention_true"
    assert progress["items"][3]["endpoint"] == "/api/agent-worker/runtime-trace-export-retention/apply"
    assert progress["items"][3]["requires_explicit_confirmation"] is True
    assert progress["items"][3]["confirmation_field"] == "confirm_retention"
    assert progress["items"][3]["confirmation_value"] is True
    assert progress["items"][3]["blocks_apply"] is True
    assert all(item["mutates_now"] is False for item in progress["items"])
    assert result["safety"] == {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    assert result["links"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress",
        "checklist": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
        "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
        "preset_advice_explanation": "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain",
        "recommended_impact_detail": "/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative",
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_preset_advice_checklist_progress_monitor_only_is_informational_and_no_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_progress"
    progress = result["progress"]
    assert progress["recommended_preset"] == "standard"
    assert progress["recommended_policy"] == STANDARD_POLICY
    assert progress["recommended_action"] == "monitor_storage"
    assert progress["severity"] == "empty"
    assert progress["operator_state"] == "monitor_only"
    assert progress["next_required_step"] is None
    assert progress["apply_allowed"] is False
    assert progress["can_apply_now"] is False
    assert progress["status_counts"] == {
        "informational": 3,
        "pending_operator_review": 1,
        "blocked_behind_explicit_confirmation": 0,
        "not_recommended": 0,
    }
    assert [item["progress_status"] for item in progress["items"]] == [
        "pending_operator_review",
        "informational",
        "informational",
        "informational",
    ]
    assert progress["items"][3]["operator_action"] == "no_apply_recommended_monitor_storage"
    assert progress["items"][3]["checklist_status"] == "not_recommended_for_monitor_only_advice"
    assert progress["items"][3]["requires_explicit_confirmation"] is True
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_dashboard_contains_preset_advice_checklist_progress_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice Checklist Progress" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistProgress" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistProgress" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress" in text
    assert "runtime_trace_export_retention_preset_advice_checklist_progress" in text
    assert "pending_operator_review" in text
    assert "blocked_behind_explicit_confirmation" in text
    assert "informational" in text
