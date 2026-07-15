import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"

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


def test_preset_advice_checklist_export_preview_returns_bounded_markdown_without_writes(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_sized_exports(tmp_path, active_count=30, archive_count=110)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview?max_chars=900")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export_preview"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["artifact_path"] is None
    assert result["artifact_relpath"] is None
    assert result["evidence"]["decision"] == "runtime_trace_export_retention_preset_advice_checklist_evidence"
    assert result["safety"] == {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "retention_apply_called": False,
        "operational_ledgers_mutated": False,
    }

    export_preview = result["export_preview"]
    assert export_preview["format"] == "markdown"
    assert export_preview["title"] == "Retention Preset Advice Checklist Evidence"
    assert export_preview["max_chars"] == 900
    assert len(export_preview["markdown_preview"]) <= 900
    assert export_preview["content_length"] >= len(export_preview["markdown_preview"])
    assert export_preview["line_count"] >= 12
    assert export_preview["truncated"] is True
    assert export_preview["redactions"] == ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"]
    assert "# Retention Preset Advice Checklist Evidence" in export_preview["markdown_preview"]
    assert "Decision: runtime_trace_export_retention_preset_advice_checklist_export_preview" in export_preview["markdown_preview"]
    assert "Recommended preset: conservative" in export_preview["markdown_preview"]
    assert "Recommended action: review_retention_preview" in export_preview["markdown_preview"]
    assert "Next required step: review_recommended_impact_detail" in export_preview["markdown_preview"]
    assert "## Safety Gates" in export_preview["markdown_preview"]
    assert "dry_run_only" in export_preview["markdown_preview"]
    assert "## Linked Endpoints" in export_preview["markdown_preview"]
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence" in export_preview["markdown_preview"]
    assert "confirmation_token" not in export_preview["markdown_preview"].lower()

    assert result["evidence_summary"] == {
        "recommended_preset": "conservative",
        "recommended_action": "review_retention_preview",
        "severity": "action_recommended",
        "operator_state": "pending_operator_review",
        "next_required_step": "review_recommended_impact_detail",
        "total_items": 4,
        "archive_candidate_count": 5,
        "prune_candidate_count": 10,
        "total_candidate_count": 15,
        "active_total": 30,
        "archived_total": 110,
    }
    assert result["links"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
        "evidence": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
        "checklist": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
        "progress": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files
    assert sorted(p.name for p in exports_dir(tmp_path).glob("*_checklist_evidence*.md")) == []


def test_preset_advice_checklist_export_preview_full_monitor_only_markdown_creates_no_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview?max_chars=0")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export_preview"
    assert result["artifact_path"] is None
    export_preview = result["export_preview"]
    assert export_preview["max_chars"] == 0
    assert export_preview["truncated"] is False
    assert export_preview["content_length"] == len(export_preview["markdown_preview"])
    assert "Recommended preset: standard" in export_preview["markdown_preview"]
    assert "Recommended action: monitor_storage" in export_preview["markdown_preview"]
    assert "Operator state: monitor_only" in export_preview["markdown_preview"]
    assert "No apply is recommended for monitor-only advice." in export_preview["markdown_preview"]
    assert result["evidence_summary"] == {
        "recommended_preset": "standard",
        "recommended_action": "monitor_storage",
        "severity": "empty",
        "operator_state": "monitor_only",
        "next_required_step": None,
        "total_items": 4,
        "archive_candidate_count": 0,
        "prune_candidate_count": 0,
        "total_candidate_count": 0,
        "active_total": 0,
        "archived_total": 0,
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()
    assert not history_path(tmp_path).exists()


def test_dashboard_contains_preset_advice_checklist_export_preview_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice Checklist Export Preview" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExportPreview" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExportPreview" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview" in text
    assert "runtime_trace_export_retention_preset_advice_checklist_export_preview" in text
    assert "markdown_preview" in text
    assert "content_length" in text
    assert "artifact_write_enabled" in text
