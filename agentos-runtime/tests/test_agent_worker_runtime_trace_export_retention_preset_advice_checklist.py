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


def test_preset_advice_checklist_returns_operator_steps_without_writes(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["advice"]["decision"] == "runtime_trace_export_retention_preset_advice"
    assert result["explanation"]["decision"] == "runtime_trace_export_retention_preset_advice_explanation"

    checklist = result["checklist"]
    assert checklist["recommended_preset"] == "conservative"
    assert checklist["recommended_policy"] == CONSERVATIVE_POLICY
    assert checklist["recommended_action"] == "review_retention_preview"
    assert checklist["severity"] == "action_recommended"
    assert checklist["apply_allowed_by_checklist"] is False
    assert checklist["requires_explicit_confirmation"] is True
    assert checklist["confirmation_field"] == "confirm_retention"
    assert checklist["confirmation_value"] is True
    assert checklist["operator_goal"] == "review_before_any_retention_apply"

    ids = [item["id"] for item in checklist["items"]]
    assert ids == [
        "review_recommended_impact_detail",
        "preview_recommended_retention_policy",
        "verify_safety_gates",
        "confirm_retention_apply_manually",
    ]
    assert checklist["items"][0] == {
        "id": "review_recommended_impact_detail",
        "order": 1,
        "title": "Review recommended preset impact detail",
        "required": True,
        "status": "pending_operator_review",
        "endpoint": "/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative",
        "mutates_now": False,
        "rationale": "Inspect exact archive and prune candidates before considering apply.",
    }
    assert checklist["items"][1] == {
        "id": "preview_recommended_retention_policy",
        "order": 2,
        "title": "Preview recommended retention policy",
        "required": True,
        "status": "pending_operator_review",
        "endpoint": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90",
        "mutates_now": False,
        "rationale": "Re-run the dry-run preview and compare counts before any confirmed apply.",
    }
    assert checklist["items"][2]["id"] == "verify_safety_gates"
    assert checklist["items"][2]["gates"] == [
        "dry_run_only",
        "retention_apply_requires_confirm_retention_true",
        "no_history_writes",
        "no_operational_ledger_mutation",
    ]
    assert checklist["items"][2]["mutates_now"] is False
    assert checklist["items"][3] == {
        "id": "confirm_retention_apply_manually",
        "order": 4,
        "title": "Confirm retention apply manually only if review passes",
        "required": True,
        "status": "blocked_until_explicit_confirmation",
        "endpoint": "/api/agent-worker/runtime-trace-export-retention/apply",
        "mutates_now": False,
        "requires_explicit_confirmation": True,
        "confirmation_field": "confirm_retention",
        "confirmation_value": True,
        "rationale": "This checklist never applies retention; a separate confirmed apply call is required.",
    }
    assert result["safety"] == {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    assert result["links"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
        "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
        "preset_advice_explanation": "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain",
        "preset_advice_audit_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview",
        "recommended_impact_detail": "/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative",
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_preset_advice_checklist_empty_workspace_keeps_apply_not_recommended_and_no_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist"
    checklist = result["checklist"]
    assert checklist["recommended_preset"] == "standard"
    assert checklist["recommended_policy"] == STANDARD_POLICY
    assert checklist["recommended_action"] == "monitor_storage"
    assert checklist["severity"] == "empty"
    assert checklist["apply_allowed_by_checklist"] is False
    assert checklist["items"][0]["endpoint"] == "/api/agent-worker/runtime-trace-export-retention/preset-impact/standard"
    assert checklist["items"][1]["endpoint"] == "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30"
    assert checklist["items"][3]["status"] == "not_recommended_for_monitor_only_advice"
    assert checklist["items"][3]["requires_explicit_confirmation"] is True
    assert result["advice"]["operator_next_steps"] == [
        "monitor_storage_summary",
        "review_preset_impact_if_disk_pressure_changes",
    ]
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_dashboard_contains_preset_advice_checklist_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice Checklist" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklist" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklist" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist" in text
    assert "runtime_trace_export_retention_preset_advice_checklist" in text
    assert "review_recommended_impact_detail" in text
    assert "preview_recommended_retention_policy" in text
    assert "confirm_retention_apply_manually" in text
