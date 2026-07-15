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


def write_export(path: Path, body: str, modified_epoch: int = 4_000_000_001):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def test_checklist_export_detail_found_returns_bounded_redacted_markdown_and_is_read_only(tmp_path):
    seed_ledgers(tmp_path)
    export_dir = checklist_export_dir(tmp_path)
    export_id = "retention_preset_advice_checklist_evidence_20260617090000_detail75"
    artifact = write_export(
        export_dir / f"{export_id}.md",
        "# Retention Preset Advice Checklist Evidence\n\n"
        "- confirmation_token: SHOULD_NOT_LEAK\n"
        "- confirmation.token=SHOULD_NOT_LEAK_EITHER\n"
        "- execution_context.confirmation_token: SHOULD_NOT_LEAK_THREE\n"
        "- Decision: runtime_trace_export_retention_preset_advice_checklist_export\n\n"
        "## Body\n\n"
        "abcdefghijklmnopqrstuvwxyz\n",
    )
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = artifact.read_text(encoding="utf-8")

    result = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/{export_id}?max_chars=120",
    )

    assert result["status"] == "runtime_trace_export_retention_preset_advice_checklist_export_found"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export_detail"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["artifact_write_enabled"] is False
    assert result["export_id"] == export_id
    assert result["filename"] == f"{export_id}.md"
    assert result["title"] == "Retention Preset Advice Checklist Evidence"
    assert result["artifact_path"] == str(artifact)
    assert result["artifact_relpath"] == f"artifacts/agent-worker/runtime-trace-retention/{export_id}.md"
    assert result["size_bytes"] == artifact.stat().st_size
    assert result["modified_at"]
    assert result["line_count"] == len(before_content.splitlines())
    assert result["content_length"] > 120
    assert result["max_chars"] == 120
    assert len(result["content_preview"]) == 120
    assert result["truncated"] is True
    assert "SHOULD_NOT_LEAK" not in result["content_preview"]
    assert "[REDACTED]" in result["content_preview"]
    assert "confirmation_token" in result["redactions"]
    assert result["links"]["export_index"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=20"
    assert result["links"]["export"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export"
    assert result["links"]["export_preview"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview"
    assert result["safety"] == {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "retention_apply_called": False,
        "operational_ledgers_mutated": False,
    }
    assert artifact.read_text(encoding="utf-8") == before_content
    assert ledger_snapshot(tmp_path) == before_ledgers


def test_checklist_export_detail_full_preview_and_not_found_do_not_create_dirs(tmp_path):
    seed_ledgers(tmp_path)
    export_dir = checklist_export_dir(tmp_path)
    export_id = "retention_preset_advice_checklist_evidence_20260617090100_full75"
    artifact = write_export(
        export_dir / f"{export_id}.md",
        "# Retention Preset Advice Checklist Evidence\n\nconfirmation_token=SECRET_FULL\nfull content marker\n",
    )
    before_ledgers = ledger_snapshot(tmp_path)

    full = call_api(
        tmp_path,
        f"/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/{export_id}?max_chars=0",
    )
    assert full["status"] == "runtime_trace_export_retention_preset_advice_checklist_export_found"
    assert full["max_chars"] == 0
    assert full["truncated"] is False
    assert "full content marker" in full["content_preview"]
    assert "SECRET_FULL" not in full["content_preview"]
    assert "confirmation_token=[REDACTED]" in full["content_preview"]

    missing = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/missing_export_75?max_chars=4000",
    )
    assert missing["status"] == "runtime_trace_export_retention_preset_advice_checklist_export_not_found"
    assert missing["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export_detail"
    assert missing["dry_run"] is True
    assert missing["will_apply"] is False
    assert missing["writes_enabled"] is False
    assert missing["artifact_write_enabled"] is False
    assert missing["export_id"] == "missing_export_75"
    assert missing["artifact_path"] is None
    assert missing["artifact_relpath"] is None
    assert missing["content_preview"] == ""
    assert missing["truncated"] is False
    assert missing["links"]["export_index"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=20"
    assert artifact.exists()
    assert ledger_snapshot(tmp_path) == before_ledgers

    missing_workspace = tmp_path / "missing-workspace"
    seed_ledgers(missing_workspace)
    missing_dir = checklist_export_dir(missing_workspace)
    assert not missing_dir.exists()
    missing_empty = call_api(
        missing_workspace,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/no_dir_export?max_chars=4000",
    )
    assert missing_empty["status"] == "runtime_trace_export_retention_preset_advice_checklist_export_not_found"
    assert not missing_dir.exists()


def test_dashboard_contains_checklist_export_detail_action_and_renderer():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExportDetail" in text
    assert "View checklist export" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/${encodeURIComponent(exportId)}?max_chars=1600" in text
    assert "runtime_trace_export_retention_preset_advice_checklist_export_detail" in text
    assert "content_preview" in text
    assert "truncated" in text
