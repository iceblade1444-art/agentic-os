import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def call_api(workspace: Path, path: str, env=None):
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, env=merged_env)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def write_voice_config(workspace: Path, *, allow_env_credentials: bool):
    config_dir = workspace / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    path = config_dir / "voice.json"
    path.write_text(json.dumps({
        "default_provider": "gemini_live",
        "providers": {
            "gemini_live": {
                "enabled": True,
                "allow_env_credentials": allow_env_credentials,
                "mode": "voice_to_voice",
                "model": "gemini-live-3.1",
                "api_key_env": "AGENTOS_TEST_RUNTIME_GEMINI_KEY",
                "fallback_api_key_env": "AGENTOS_TEST_RUNTIME_GOOGLE_KEY"
            }
        }
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def snapshot_files(workspace: Path):
    return {
        path.relative_to(workspace).as_posix(): path.read_text(encoding="utf-8", errors="replace")
        for path in sorted(workspace.rglob("*"))
        if path.is_file()
    }


def test_dashboard_runtime_diagnostics_reports_pid_env_visibility_and_is_read_only(tmp_path):
    write_voice_config(tmp_path, allow_env_credentials=True)
    before = snapshot_files(tmp_path)
    env = {"AGENTOS_TEST_RUNTIME_GEMINI_KEY": "runtime-secret-key"}

    result = call_api(tmp_path, "/api/dashboard/runtime-diagnostics", env=env)

    assert result["status"] == "ok"
    assert result["decision"] == "dashboard_runtime_diagnostics"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["read_only"] is True
    assert result["workspace"] == str(tmp_path)
    assert isinstance(result["process"]["pid"], int)
    assert result["process"]["pid"] > 0
    assert result["process"]["argv_count"] >= 1
    assert result["credential_visibility"]["gemini_live"] == {
        "provider": "gemini_live",
        "ready": True,
        "reasons": ["ready"],
        "enabled": True,
        "allow_env_credentials": True,
        "has_env_key": True,
        "has_inline_key": False,
        "api_key_env_names": ["AGENTOS_TEST_RUNTIME_GEMINI_KEY", "AGENTOS_TEST_RUNTIME_GOOGLE_KEY"],
        "local_override_exists": False,
    }
    assert result["safety"] == {
        "read_only": True,
        "process_mutation_enabled": False,
        "config_writes_enabled": False,
        "secrets_redacted": True,
        "raw_env_values_returned": False,
    }
    serialized = json.dumps(result, ensure_ascii=False)
    assert "runtime-secret-key" not in serialized
    assert snapshot_files(tmp_path) == before


def test_dashboard_runtime_diagnostics_does_not_count_env_key_without_opt_in(tmp_path):
    write_voice_config(tmp_path, allow_env_credentials=False)
    env = {"AGENTOS_TEST_RUNTIME_GEMINI_KEY": "runtime-secret-key"}

    result = call_api(tmp_path, "/api/dashboard/runtime-diagnostics", env=env)

    gemini = result["credential_visibility"]["gemini_live"]
    assert gemini["allow_env_credentials"] is False
    assert gemini["has_env_key"] is False
    assert gemini["ready"] is False
    assert "missing_credentials" in gemini["reasons"]
    assert "runtime-secret-key" not in json.dumps(result, ensure_ascii=False)


def test_dashboard_runtime_diagnostics_export_preview_is_bounded_redacted_and_read_only(tmp_path):
    write_voice_config(tmp_path, allow_env_credentials=True)
    before = snapshot_files(tmp_path)
    env = {"AGENTOS_TEST_RUNTIME_GEMINI_KEY": "runtime-secret-key"}

    result = call_api(tmp_path, "/api/dashboard/runtime-diagnostics/export?max_chars=120", env=env)

    assert result["status"] == "ok"
    assert result["decision"] == "dashboard_runtime_diagnostics_export_preview"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["read_only"] is True
    assert result["artifact_path"] is None
    assert result["artifact_relpath"] is None
    assert result["runtime_diagnostics"]["status"] == "ok"
    assert result["runtime_diagnostics"]["credential_visibility"]["gemini_live"]["has_env_key"] is True
    assert result["export_preview"]["format"] == "markdown"
    assert result["export_preview"]["title"] == "AgentOS Dashboard Runtime Diagnostics"
    assert result["export_preview"]["max_chars"] == 120
    assert len(result["export_preview"]["markdown_preview"]) <= 120
    assert result["export_preview"]["content_length"] >= len(result["export_preview"]["markdown_preview"])
    assert result["export_preview"]["truncated"] is True
    assert result["safety"] == {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "process_mutation_enabled": False,
        "config_writes_enabled": False,
        "raw_env_values_returned": False,
        "secrets_redacted": True,
    }
    serialized = json.dumps(result, ensure_ascii=False)
    assert "runtime-secret-key" not in serialized
    assert snapshot_files(tmp_path) == before


def test_dashboard_runtime_diagnostics_export_preview_max_chars_zero_returns_full_markdown(tmp_path):
    write_voice_config(tmp_path, allow_env_credentials=False)
    env = {"AGENTOS_TEST_RUNTIME_GEMINI_KEY": "runtime-secret-key"}

    result = call_api(tmp_path, "/api/dashboard/runtime-diagnostics/export?max_chars=0", env=env)

    preview = result["export_preview"]
    assert preview["truncated"] is False
    assert preview["content_length"] == len(preview["markdown_preview"])
    assert "# AgentOS Dashboard Runtime Diagnostics" in preview["markdown_preview"]
    assert "allow_env_credentials: False" in preview["markdown_preview"]
    assert "has_env_key: False" in preview["markdown_preview"]
    assert "runtime-secret-key" not in json.dumps(result, ensure_ascii=False)


def test_dashboard_contains_runtime_diagnostics_panel_and_refresh_loader():
    text = INDEX.read_text(encoding="utf-8")
    assert "Dashboard Runtime Diagnostics" in text
    assert "dashboardRuntimeDiagnostics" in text
    assert "loadDashboardRuntimeDiagnostics" in text
    assert "loadDashboardRuntimeDiagnosticsExportPreview" in text
    assert "/api/dashboard/runtime-diagnostics" in text
    assert "/api/dashboard/runtime-diagnostics/export" in text
    assert "Export runtime diagnostics preview" in text
    assert "secrets_redacted" in text
    refresh_line = next(line for line in text.splitlines() if "Promise.all" in line and "loadStatus()" in line)
    assert "loadDashboardRuntimeDiagnostics()" in refresh_line
