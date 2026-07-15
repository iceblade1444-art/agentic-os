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
        paths.append(write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:03d}_trace_202606170707{idx:03d}.md", 20 + idx, base + 100 + idx))
    return paths


def test_preset_advice_explain_returns_human_readable_blocks_without_writes(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_explanation"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["advice"]["decision"] == "runtime_trace_export_retention_preset_advice"
    assert result["advice"]["recommended_preset"] == "conservative"

    explanation = result["explanation"]
    assert explanation["summary"].startswith("Recommended preset conservative")
    assert explanation["recommended"]["preset"] == "conservative"
    assert explanation["recommended"]["policy"] == CONSERVATIVE_POLICY
    assert explanation["recommended"]["action"] == "review_retention_preview"
    assert explanation["recommended"]["severity"] == "action_recommended"
    assert explanation["recommended"]["reason_codes"] == [
        "preset_impact_matrix_evaluated",
        "conservative_has_candidates_safest_action",
        "retention_apply_requires_confirm_retention_true",
    ]
    assert explanation["recommended"]["impact_summary"] == {
        "archive_candidate_count": 5,
        "prune_candidate_count": 10,
        "total_candidate_count": 15,
        "total_candidate_size_bytes": result["advice"]["recommended_impact"]["total_candidate_size_bytes"],
    }
    assert "safest preset" in explanation["recommended"]["explanation"]
    assert explanation["operator_steps"] == [
        "review_conservative_impact_detail",
        "preview_conservative_retention",
        "apply_retention_requires_confirm_retention_true",
    ]

    alternatives = {item["preset"]: item for item in explanation["alternatives"]}
    assert set(alternatives) == {"standard", "aggressive"}
    assert alternatives["standard"]["guidance_level"] == "more_aggressive_than_recommended"
    assert alternatives["standard"]["candidate_count"] >= explanation["recommended"]["impact_summary"]["total_candidate_count"]
    assert alternatives["standard"]["impact_detail_url"] == "/api/agent-worker/runtime-trace-export-retention/preset-impact/standard"
    assert alternatives["aggressive"]["guidance_level"] == "higher_churn_available"
    assert alternatives["aggressive"]["preview_url"].startswith("/api/agent-worker/runtime-trace-export-retention/preview?")

    safety_codes = [item["code"] for item in explanation["safety_gates"]]
    assert safety_codes == [
        "dry_run_only",
        "retention_apply_requires_confirm_retention_true",
        "no_history_writes",
        "no_operational_ledger_mutation",
    ]
    assert result["safety"] == {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    assert result["links"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain",
        "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
        "preset_advice_audit_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview",
        "recommended_impact_detail": "/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative",
        "recommended_preview": result["advice"]["links"]["recommended_preview"],
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_preset_advice_explain_empty_workspace_returns_monitor_explanation_and_no_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_explanation"
    assert result["advice"]["recommended_preset"] == "standard"
    assert result["advice"]["recommended_action"] == "monitor_storage"
    assert result["advice"]["severity"] == "empty"
    explanation = result["explanation"]
    assert explanation["summary"] == "Recommended preset standard: monitor_storage (empty)."
    assert explanation["recommended"]["preset"] == "standard"
    assert explanation["recommended"]["policy"] == STANDARD_POLICY
    assert explanation["recommended"]["impact_summary"] == {
        "archive_candidate_count": 0,
        "prune_candidate_count": 0,
        "total_candidate_count": 0,
        "total_candidate_size_bytes": 0,
    }
    assert "No runtime trace export artifacts were detected" in explanation["recommended"]["explanation"]
    assert explanation["alternatives"][0]["candidate_count"] == 0
    assert explanation["alternatives"][1]["candidate_count"] == 0
    assert explanation["operator_steps"] == [
        "monitor_storage_summary",
        "review_preset_impact_if_disk_pressure_changes",
    ]
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()
    assert not (tmp_path / "logs" / "agent-worker" / "retention-preset-advice-history.json").exists()


def test_dashboard_contains_preset_advice_explain_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice Explanation" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdviceExplanation" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceExplanation" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain" in text
    assert "runtime_trace_export_retention_preset_advice_explanation" in text
    assert "safety_gates" in text
    assert "alternatives" in text
    assert "operator_steps" in text
