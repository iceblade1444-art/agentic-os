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


def write_export(path: Path, body: str, modified_epoch: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def test_checklist_export_index_missing_dir_is_empty_and_read_only(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)
    export_dir = checklist_export_dir(tmp_path)
    assert not export_dir.exists()

    result = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=20",
    )

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export_index"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["artifact_write_enabled"] is False
    assert result["path"] == str(export_dir)
    assert result["relpath"] == "artifacts/agent-worker/runtime-trace-retention"
    assert result["total"] == 0
    assert result["count"] == 0
    assert result["limit"] == 20
    assert result["exports"] == []
    assert result["links"]["exports_dir"] == "artifacts/agent-worker/runtime-trace-retention"
    assert result["links"]["export_preview"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview"
    assert result["links"]["export"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export"
    assert result["safety"] == {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "retention_apply_called": False,
        "operational_ledgers_mutated": False,
    }
    assert not export_dir.exists()
    assert ledger_snapshot(tmp_path) == before_ledgers


def test_checklist_export_index_lists_dossiers_newest_first_with_limit(tmp_path):
    seed_ledgers(tmp_path)
    export_dir = checklist_export_dir(tmp_path)
    old = write_export(
        export_dir / "retention_preset_advice_checklist_evidence_20260617080000_old12345.md",
        "# Retention Preset Advice Checklist Evidence\n\nold dossier\n",
        4_000_000_001,
    )
    newest = write_export(
        export_dir / "retention_preset_advice_checklist_evidence_20260617080200_new12345.md",
        "# Retention Preset Advice Checklist Evidence\n\nnew dossier\n",
        4_000_000_003,
    )
    middle = write_export(
        export_dir / "retention_preset_advice_checklist_evidence_20260617080100_mid12345.md",
        "# Retention Preset Advice Checklist Evidence\n\nmid dossier\n",
        4_000_000_002,
    )
    ignored = write_export(export_dir / "unrelated.md", "# Retention Preset Advice Checklist Evidence\n\nignore me\n", 4_000_000_004)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path.name: path.read_text(encoding="utf-8") for path in [old, newest, middle, ignored]}

    limited = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=2",
    )
    assert limited["status"] == "ok"
    assert limited["decision"] == "runtime_trace_export_retention_preset_advice_checklist_export_index"
    assert limited["total"] == 3
    assert limited["count"] == 2
    assert limited["limit"] == 2
    assert [item["filename"] for item in limited["exports"]] == [newest.name, middle.name]
    assert [item["export_id"] for item in limited["exports"]] == [newest.stem, middle.stem]
    assert all(item["title"] == "Retention Preset Advice Checklist Evidence" for item in limited["exports"])
    assert all(item["artifact_relpath"].startswith("artifacts/agent-worker/runtime-trace-retention/") for item in limited["exports"])
    assert all(item["size_bytes"] > 0 for item in limited["exports"])
    assert all(item["modified_at"] for item in limited["exports"])
    assert limited["exports"][0]["links"]["export"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export"
    assert limited["exports"][0]["links"]["export_preview"] == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview"

    all_exports = call_api(
        tmp_path,
        "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=0",
    )
    assert all_exports["total"] == 3
    assert all_exports["count"] == 3
    assert all_exports["limit"] == 0
    assert [item["filename"] for item in all_exports["exports"]] == [newest.name, middle.name, old.name]

    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path.name: path.read_text(encoding="utf-8") for path in [old, newest, middle, ignored]} == before_files


def test_dashboard_contains_checklist_export_index_panel_and_refresh_loader():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Preset Advice Checklist Exports" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExports" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExports" in text
    assert "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=10" in text
    assert "runtime_trace_export_retention_preset_advice_checklist_export_index" in text
    assert "artifact_relpath" in text
    refresh_line = next(line for line in text.splitlines() if "Promise.all" in line and "loadStatus()" in line)
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExports()" in refresh_line
