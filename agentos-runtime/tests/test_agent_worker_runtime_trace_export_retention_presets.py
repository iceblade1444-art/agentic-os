import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


EXPECTED_PRESETS = {
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


def write_artifact(path: Path, content: str, modified_epoch: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def seed_exports(workspace: Path, active_count=0, archive_count=0):
    # Future mtimes keep candidate counts focused on preset max-count rules, not age rules.
    base = 4_000_000_000
    paths = []
    for idx in range(active_count):
        paths.append(write_artifact(exports_dir(workspace) / f"runtime_active_{idx:02d}_trace.md", f"active-{idx}", base + idx))
    for idx in range(archive_count):
        paths.append(write_artifact(archive_dir(workspace) / f"runtime_archive_{idx:02d}_trace_202606170101{idx:02d}.md", f"archive-{idx}", base + 100 + idx))
    return paths


def test_retention_presets_endpoint_returns_read_only_named_policies_without_creating_dirs(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/presets")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_retention_presets"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["default_preset"] == "standard"
    assert result["preset_names"] == ["conservative", "standard", "aggressive"]
    assert [preset["name"] for preset in result["presets"]] == result["preset_names"]
    assert {preset["name"]: preset["policy"] for preset in result["presets"]} == EXPECTED_PRESETS
    assert {preset["name"]: preset["is_default"] for preset in result["presets"]} == {"conservative": False, "standard": True, "aggressive": False}
    assert all(preset["dry_run"] is True and preset["will_apply"] is False for preset in result["presets"])
    assert all("preview_url" in preset and "retention_apply_requires_confirmation" in preset["operator_note"] for preset in result["presets"])
    assert result["history"] == {"status": "not_recorded", "records": [], "writes_enabled": False, "reason": "retention_presets_are_read_only"}
    assert result["links"] == {
        "self": "/api/agent-worker/runtime-trace-export-retention/presets",
        "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/recommended-preview",
        "recommendations": "/api/agent-worker/runtime-trace-export-retention/recommendations",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_retention_presets_preview_urls_are_compatible_with_existing_preview_and_read_only(tmp_path):
    seed_ledgers(tmp_path)
    paths = seed_exports(tmp_path, active_count=12, archive_count=52)
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path: path.read_text(encoding="utf-8") for path in paths}

    presets = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/presets")
    preview_counts = {}
    for preset in presets["presets"]:
        preview = call_api(tmp_path, preset["preview_url"])
        assert preview["status"] == "ok"
        assert preview["decision"] == "runtime_trace_export_retention_preview"
        assert preview["dry_run"] is True
        assert preview["will_apply"] is False
        assert preview["policy"] == preset["policy"]
        preview_counts[preset["name"]] = preview["counts"]

    assert preview_counts["conservative"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 0, "prune_candidates": 0}
    assert preview_counts["standard"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 2, "prune_candidates": 2}
    assert preview_counts["aggressive"] == {"active_total": 12, "archived_total": 52, "archive_candidates": 9, "prune_candidates": 42}
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path: path.read_text(encoding="utf-8") for path in before_files} == before_files


def test_retention_presets_preview_urls_are_canonical_query_strings(tmp_path):
    seed_ledgers(tmp_path)

    presets = call_api(tmp_path, "/api/agent-worker/runtime-trace-export-retention/presets")

    for preset in presets["presets"]:
        parsed = urlparse(preset["preview_url"])
        assert parsed.path == "/api/agent-worker/runtime-trace-export-retention/preview"
        query = parse_qs(parsed.query)
        assert query == {
            "max_active": [str(preset["policy"]["max_active"])],
            "max_archived": [str(preset["policy"]["max_archived"])],
            "older_than_days": [str(preset["policy"]["older_than_days"])],
        }


def test_dashboard_contains_retention_policy_preset_buttons_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Retention Policy Presets" in text
    assert "agentWorkerRuntimeTraceExportRetentionPresets" in text
    assert "loadAgentWorkerRuntimeTraceExportRetentionPresets" in text
    assert "previewAgentWorkerRuntimeTraceExportRetentionPreset" in text
    assert "/api/agent-worker/runtime-trace-export-retention/presets" in text
    assert "runtime_trace_export_retention_presets" in text
    assert "conservative" in text
    assert "standard" in text
    assert "aggressive" in text
