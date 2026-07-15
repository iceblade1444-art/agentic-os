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


def test_production_readiness_credential_handoff_missing_credentials_is_read_only(tmp_path):
    write_voice_local(tmp_path, {"enabled": True})
    before = snapshot_files(tmp_path)

    result = call_api(tmp_path, "/api/production-readiness/credential-handoff")

    assert result["status"] == "ok"
    assert result["decision"] == "production_readiness_credential_handoff"
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
    assert handoff["provider"] == "gemini_live"
    assert handoff["handoff_status"] in {"missing_credentials", "credentials_present_verify_transport"}
    if handoff["handoff_status"] == "missing_credentials":
        assert handoff["remaining_external_blocker"] == "gemini_live"
        assert handoff["current_status"]["ready"] is False
        assert "missing_credentials" in handoff["current_status"]["reasons"]
    else:
        assert handoff["remaining_external_blocker"] is None
        assert handoff["current_status"]["ready"] is True
    assert handoff["required_credentials"] == ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
    assert handoff["preferred_credential"] == "GEMINI_API_KEY"
    assert handoff["fallback_credential"] == "GOOGLE_API_KEY"
    assert handoff["local_override_example_relpath"] == "config/voice.local.example.json"
    assert handoff["local_override_relpath"] == "config/voice.local.json"
    assert handoff["recommended_storage"] == "environment_variable"
    assert handoff["do_not_store_in_dashboard"] is True
    assert handoff["actions_stay_routed_through_command_bridge"] is True
    assert handoff["approval_gates_remain_required"] is True

    step_ids = [step["id"] for step in handoff["setup_steps"]]
    assert step_ids == [
        "obtain_google_ai_studio_key",
        "set_environment_variable",
        "enable_gemini_live_provider",
        "restart_dashboard_backend",
        "verify_voice_status",
        "run_gemini_live_probe",
        "run_safe_command_session",
    ]
    assert "setx GEMINI_API_KEY" in handoff["setup_steps"][1]["windows_user_command"]
    assert "export GEMINI_API_KEY" in handoff["setup_steps"][1]["git_bash_command"]
    assert handoff["verification_commands"] == [
        "python agentosctl.py --workspace C:/Users/User/AgentOS voice status --pretty",
        "python agentosctl.py --workspace C:/Users/User/AgentOS voice test --provider gemini_live --pretty",
        "python agentosctl.py --workspace C:/Users/User/AgentOS voice session --provider gemini_live --text \"покажи digest\" --pretty",
        "python agentosctl.py --workspace C:/Users/User/AgentOS release check --pretty",
    ]
    assert result["links"] == {
        "production_readiness": "/api/production-readiness",
        "production_readiness_export": "/api/production-readiness/export?max_chars=4000",
        "voice_health": "/api/voice-health",
        "voice_config": "/api/voice-config",
    }
    assert snapshot_files(tmp_path) == before


def test_production_readiness_credential_handoff_redacts_inline_key(tmp_path):
    write_voice_local(tmp_path, {"enabled": True, "api_key": "super-secret-inline-key"})

    result = call_api(tmp_path, "/api/production-readiness/credential-handoff")
    serialized = json.dumps(result, ensure_ascii=False)

    assert result["status"] == "ok"
    assert result["credential_handoff"]["handoff_status"] == "credentials_present_verify_transport"
    assert result["credential_handoff"]["remaining_external_blocker"] is None
    assert result["credential_handoff"]["current_status"]["ready"] is True
    assert result["credential_handoff"]["current_status"]["has_inline_key"] is True
    assert "super-secret-inline-key" not in serialized
    assert "[REDACTED]" in serialized
    assert result["safety"]["config_writes_enabled"] is False


def test_dashboard_contains_production_readiness_credential_handoff_panel_and_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Gemini Credential Handoff" in text
    assert "productionReadinessCredentialHandoff" in text
    assert "loadProductionReadinessCredentialHandoff" in text
    assert "/api/production-readiness/credential-handoff" in text
    assert "production_readiness_credential_handoff" in text
    assert "GEMINI_API_KEY" in text
    assert "GOOGLE_API_KEY" in text
    assert "actions_stay_routed_through_command_bridge" in text
