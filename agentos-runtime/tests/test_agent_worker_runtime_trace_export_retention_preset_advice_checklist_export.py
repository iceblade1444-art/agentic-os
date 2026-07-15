import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


EXPECTED_REDACTIONS = ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"]


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


def checklist_export_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-trace-retention"


def previews_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def attempts_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json"


def audits_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def runs_path(workspace: Path):
    return workspace / "logs" / "agent-queue" / "runs.json"


def history_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "retention-preset-advice-history.json"


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
        "history_exists": history_path(workspace).exists(),
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


def test_preset_advice_checklist_export_requires_confirmation_and_creates_no_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export",
        method="POST",
        payload={"confirm_export": False, "reason": "test"},
    )

    assert result == {
        "status": "runtime_trace_export_retention_preset_advice_checklist_export_confirmation_required",
        "decision": "runtime_trace_export_retention_preset_advice_checklist_export",
        "dry_run": True,
        "will_export": False,
        "writes_enabled": False,
        "artifact_write_enabled": False,
        "required_confirmation": {"confirm_export": True},
        "artifact_path": None,
        "artifact_relpath": None,
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "retention_apply_called": False,
            "operational_ledgers_mutated": False,
        },
        "links": {
            "export_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
            "evidence": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
        },
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not checklist_export_dir(tmp_path).exists()
    assert not history_path(tmp_path).exists()


def test_preset_advice_checklist_export_confirmed_writes_only_markdown_artifact(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export",
        method="POST",
        payload={"confirm_export": True, "reason": "operator_verified_evidence"},
    )

    assert result["status"] == "runtime_trace_export_retention_preset_advice_checklist_exported"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export"
    assert result["dry_run"] is False
    assert result["will_export"] is True
    assert result["writes_enabled"] is True
    assert result["artifact_write_enabled"] is True
    assert result["reason"] == "operator_verified_evidence"
    assert result["artifact_only_mutation"] is True
    assert result["operational_ledgers_mutated"] is False
    assert result["history_writes_enabled"] is False
    assert result["retention_apply_called"] is False
    assert result["evidence_summary"]["recommended_preset"] == "conservative"
    assert result["evidence_summary"]["recommended_action"] == "review_retention_preview"
    assert result["evidence_summary"]["severity"] == "action_recommended"
    assert result["evidence_summary"]["operator_state"] == "pending_operator_review"
    assert result["evidence_summary"]["archive_candidate_count"] == 5
    assert result["evidence_summary"]["prune_candidate_count"] == 10
    assert result["evidence_summary"]["total_candidate_count"] == 15
    assert result["export_preview"]["format"] == "markdown"
    assert result["export_preview"]["content_length"] == result["artifact_size_bytes"]
    assert result["export_preview"]["redactions"] == EXPECTED_REDACTIONS
    assert result["links"]["export_preview"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview"
    assert result["links"]["evidence"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence"

    artifact_path = Path(result["artifact_path"])
    assert artifact_path.exists()
    assert artifact_path.parent == checklist_export_dir(tmp_path)
    assert artifact_path.name.startswith("retention_preset_advice_checklist_evidence_")
    assert artifact_path.name.endswith(".md")
    assert result["artifact_relpath"].startswith("artifacts/agent-worker/runtime-trace-retention/")
    content = artifact_path.read_text(encoding="utf-8")
    assert content.startswith("# Retention Preset Advice Checklist Evidence")
    assert "Decision: runtime_trace_export_retention_preset_advice_checklist_export" in content
    assert "Recommended preset: conservative" in content
    assert "Recommended action: review_retention_preview" in content
    assert "## Safety Gates" in content
    assert "dry_run_only" in content
    assert "## Linked Endpoints" in content
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence" in content
    assert "operator_verified_evidence" in content
    assert "confirmation_token" not in content.lower()

    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files
    assert sorted(path.name for path in checklist_export_dir(tmp_path).glob("*.md")) == [artifact_path.name]


def test_dashboard_contains_preset_advice_checklist_export_action_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Export checklist evidence dossier" in text
    assert "exportAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklist" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export" in text
    assert "confirm_export" in text
    assert "runtime_trace_export_retention_preset_advice_checklist_export" in text
    assert "artifact_relpath" in text
    assert "artifact_write_enabled" in text
