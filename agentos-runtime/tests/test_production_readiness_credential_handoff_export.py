import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def call_api(workspace: Path, path: str):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def write_voice_local(workspace: Path, gemini: dict):
    path = workspace / "config" / "voice.local.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"providers": {"gemini_live": gemini}}, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def snapshot_files(workspace: Path):
    return {
        path.relative_to(workspace).as_posix(): path.read_text(encoding="utf-8", errors="replace")
        for path in sorted(workspace.rglob("*"))
        if path.is_file()
    }


def test_credential_handoff_export_preview_is_bounded_redacted_and_read_only(tmp_path):
    write_voice_local(tmp_path, {"enabled": True})
    before = snapshot_files(tmp_path)

    result = call_api(tmp_path, "/api/production-readiness/credential-handoff/export?max_chars=900")

    assert result["status"] == "ok"
    assert result["decision"] == "production_readiness_credential_handoff_export_preview"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["read_only"] is True
    assert result["artifact_path"] is None
    assert result["artifact_relpath"] is None
    assert result["safety"] == {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
        "config_writes_enabled": False,
        "voice_session_started": False,
    }

    handoff = result["credential_handoff"]
    assert handoff["handoff_status"] in {"missing_credentials", "credentials_present_verify_transport"}
    if handoff["handoff_status"] == "missing_credentials":
        assert handoff["remaining_external_blocker"] == "gemini_live"
    else:
        assert handoff["remaining_external_blocker"] is None
    assert handoff["required_credentials"] == ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
    assert handoff["actions_stay_routed_through_command_bridge"] is True

    preview = result["export_preview"]
    assert preview["format"] == "markdown"
    assert preview["title"] == "AgentOS Gemini Credential Handoff"
    assert preview["max_chars"] == 900
    assert preview["content_length"] > 900
    assert len(preview["markdown_preview"]) == 900
    assert preview["truncated"] is True
    assert preview["line_count"] >= 20
    assert preview["redactions"] == ["api_key", "token", "secret", "password"]
    assert preview["markdown_preview"].startswith("# AgentOS Gemini Credential Handoff")
    assert "production_readiness_credential_handoff_export_preview" in preview["markdown_preview"]
    assert "GEMINI_API_KEY" in preview["markdown_preview"]
    assert "GOOGLE_API_KEY" in preview["markdown_preview"]
    assert "actions_stay_routed_through_command_bridge" in preview["markdown_preview"]

    assert result["links"] == {
        "credential_handoff": "/api/production-readiness/credential-handoff",
        "production_readiness": "/api/production-readiness",
        "voice_health": "/api/voice-health",
        "voice_config": "/api/voice-config",
    }
    assert snapshot_files(tmp_path) == before


def test_credential_handoff_export_preview_full_mode_and_inline_key_redaction(tmp_path):
    write_voice_local(tmp_path, {"enabled": True, "api_key": "super-secret-inline-key"})
    before = snapshot_files(tmp_path)

    result = call_api(tmp_path, "/api/production-readiness/credential-handoff/export?max_chars=0")
    serialized = json.dumps(result, ensure_ascii=False)
    preview = result["export_preview"]

    assert result["status"] == "ok"
    assert result["credential_handoff"]["handoff_status"] == "credentials_present_verify_transport"
    assert result["credential_handoff"]["remaining_external_blocker"] is None
    assert result["credential_handoff"]["current_status"]["ready"] is True
    assert result["credential_handoff"]["current_status"]["has_inline_key"] is True
    assert preview["max_chars"] == 0
    assert preview["truncated"] is False
    assert len(preview["markdown_preview"]) == preview["content_length"]
    assert "credentials_present_verify_transport" in preview["markdown_preview"]
    assert "super-secret-inline-key" not in serialized
    assert "[REDACTED]" in serialized
    assert snapshot_files(tmp_path) == before


def test_dashboard_contains_credential_handoff_export_preview_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Export credential handoff preview" in text
    assert "loadProductionReadinessCredentialHandoffExportPreview" in text
    assert "/api/production-readiness/credential-handoff/export?max_chars=1600" in text
    assert "production_readiness_credential_handoff_export_preview" in text
    assert "markdown_preview" in text
    assert "artifact_write_enabled" in text
    assert "config_writes_enabled" in text
