import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_voice_config(workspace: Path) -> None:
    config_dir = workspace / "config"
    config_dir.mkdir(parents=True)
    (config_dir / "voice.json").write_text(json.dumps({
        "default_provider": "mock_text",
        "providers": {
            "mock_text": {"enabled": True, "mode": "text_to_command"},
            "gemini_live": {
                "enabled": False,
                "mode": "voice_to_voice",
                "api_key_env": "GEMINI_API_KEY",
                "fallback_api_key_env": "GOOGLE_API_KEY",
                "model": "gemini-live-3.1"
            }
        }
    }), encoding="utf-8")


def isolated_env():
    env = os.environ.copy()
    env.pop("GEMINI_API_KEY", None)
    env.pop("GOOGLE_API_KEY", None)
    return env


def run_cli(workspace: Path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True, env=isolated_env())


def call_api(workspace: Path, path: str):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"print(json.dumps(handle_api({str(workspace)!r}, {path!r}), ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, env=isolated_env())


def test_agentosctl_voice_status_reports_provider_readiness(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "status")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ok"
    assert data["summary"] == {"providers": 2, "ready": 1, "not_ready": 1}
    providers = {item["provider"]: item for item in data["providers"]}
    assert providers["mock_text"]["ready"] is True
    assert providers["gemini_live"]["ready"] is False
    assert "disabled" in providers["gemini_live"]["reasons"]
    assert "missing_credentials" in providers["gemini_live"]["reasons"]


def test_agentosctl_voice_status_redacts_local_secret(tmp_path):
    write_voice_config(tmp_path)
    (tmp_path / "config" / "voice.local.json").write_text(json.dumps({
        "providers": {"gemini_live": {"enabled": True, "api_key": "real-secret-value"}}
    }), encoding="utf-8")

    result = run_cli(tmp_path, "voice", "status")

    assert result.returncode == 0, result.stderr
    assert "real-secret-value" not in result.stdout
    data = json.loads(result.stdout)
    gemini = next(item for item in data["providers"] if item["provider"] == "gemini_live")
    assert gemini["enabled"] is True
    assert gemini["has_inline_key"] is True


def test_voice_health_api_matches_cli_shape(tmp_path):
    write_voice_config(tmp_path)

    result = call_api(tmp_path, "/api/voice-health")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ok"
    assert data["summary"]["providers"] == 2
    assert any(item["provider"] == "gemini_live" and "disabled" in item["reasons"] for item in data["providers"])


def test_dashboard_contains_voice_health_panel():
    text = INDEX.read_text(encoding="utf-8")
    assert "Voice Provider Health" in text
    assert "id=\"voiceHealth\"" in text
    assert "fetch('/api/voice-health')" in text
    assert "loadVoiceHealth" in text
