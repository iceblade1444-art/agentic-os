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
EXPECTED_GATES = [
    "dry_run_only",
    "retention_apply_requires_confirm_retention_true",
    "no_history_writes",
    "no_operational_ledger_mutation",
]
EXPECTED_ITEMS = [
    "review_recommended_impact_detail",
    "preview_recommended_retention_policy",
    "verify_safety_gates",
    "confirm_retention_apply_manually",
]


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
        paths.append(write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:03d}_trace_202606171010{idx:03d}.md", 20 + idx, base + 100 + idx))
    return paths


def test_preset_advice_checklist_evidence_bundles_progress_impact_preview_and_links_without_writes(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_evidence"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["checklist"]["decision"] == "runtime_trace_export_retention_preset_advice_checklist"
    assert result["progress"]["decision"] == "runtime_trace_export_retention_preset_advice_checklist_progress"

    evidence = result["evidence"]
    assert evidence["bundle_type"] == "retention_preset_advice_checklist_evidence"
    assert evidence["recommended_preset"] == "conservative"
    assert evidence["recommended_policy"] == CONSERVATIVE_POLICY
    assert evidence["recommended_action"] == "review_retention_preview"
    assert evidence["severity"] == "action_recommended"
    assert evidence["operator_state"] == "pending_operator_review"
    assert evidence["next_required_step"] == "review_recommended_impact_detail"
    assert evidence["apply_allowed"] is False
    assert evidence["can_apply_now"] is False

    assert evidence["checklist_summary"] == {
        "total_items": 4,
        "operator_state": "pending_operator_review",
        "next_required_step": "review_recommended_impact_detail",
        "status_counts": {
            "informational": 1,
            "pending_operator_review": 2,
            "blocked_behind_explicit_confirmation": 1,
            "not_recommended": 0,
        },
    }
    assert evidence["item_ids"] == EXPECTED_ITEMS
    assert [item["id"] for item in evidence["items"]] == EXPECTED_ITEMS
    assert [item["progress_status"] for item in evidence["items"]] == [
        "pending_operator_review",
        "pending_operator_review",
        "informational",
        "blocked_behind_explicit_confirmation",
    ]
    assert all(item["mutates_now"] is False for item in evidence["items"])

    assert evidence["impact_summary"] == {
        "preset_name": "conservative",
        "archive_candidate_count": 5,
        "prune_candidate_count": 10,
        "total_candidate_count": 15,
        "archive_candidate_size_bytes": 60,
        "prune_candidate_size_bytes": 245,
        "total_candidate_size_bytes": 305,
    }
    assert evidence["preview_counts"] == {
        "active_total": 30,
        "archived_total": 110,
        "archive_candidates": 5,
        "prune_candidates": 10,
    }
    assert evidence["safety_gates"] == EXPECTED_GATES
    assert evidence["linked_endpoints"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
        "checklist": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
        "progress": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress",
        "recommended_impact_detail": "/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative",
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert result["safety"] == {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_preset_advice_checklist_evidence_monitor_only_keeps_apply_unavailable_and_no_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_evidence"
    evidence = result["evidence"]
    assert evidence["recommended_preset"] == "standard"
    assert evidence["recommended_policy"] == STANDARD_POLICY
    assert evidence["recommended_action"] == "monitor_storage"
    assert evidence["severity"] == "empty"
    assert evidence["operator_state"] == "monitor_only"
    assert evidence["next_required_step"] is None
    assert evidence["apply_allowed"] is False
    assert evidence["can_apply_now"] is False
    assert evidence["checklist_summary"] == {
        "total_items": 4,
        "operator_state": "monitor_only",
        "next_required_step": None,
        "status_counts": {
            "informational": 3,
            "pending_operator_review": 1,
            "blocked_behind_explicit_confirmation": 0,
            "not_recommended": 0,
        },
    }
    assert evidence["impact_summary"] == {
        "preset_name": "standard",
        "archive_candidate_count": 0,
        "prune_candidate_count": 0,
        "total_candidate_count": 0,
        "archive_candidate_size_bytes": 0,
        "prune_candidate_size_bytes": 0,
        "total_candidate_size_bytes": 0,
    }
    assert evidence["preview_counts"] == {
        "active_total": 0,
        "archived_total": 0,
        "archive_candidates": 0,
        "prune_candidates": 0,
    }
    assert evidence["items"][3]["progress_status"] == "informational"
    assert evidence["items"][3]["operator_action"] == "no_apply_recommended_monitor_storage"
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_dashboard_contains_preset_advice_checklist_evidence_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice Checklist Evidence" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistEvidence" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistEvidence" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence" in text
    assert "runtime_trace_export_retention_preset_advice_checklist_evidence" in text
    assert "impact_summary" in text
    assert "preview_counts" in text
    assert "linked_endpoints" in text
