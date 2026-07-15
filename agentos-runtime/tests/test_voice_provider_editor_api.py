import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(tmp_path)!r}, {path!r}, method={method!r}, payload={repr(payload)}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_voice_config_api_merges_local_and_redacts_secrets(tmp_path):
    config_dir = tmp_path / "config"
    config_dir.mkdir(parents=True)
    (config_dir / "voice.json").write_text(json.dumps({
        "default_provider": "mock_text",
        "providers": {"gemini_live": {"enabled": False, "api_key_env": "GEMINI_API_KEY"}}
    }), encoding="utf-8")
    (config_dir / "voice.local.json").write_text(json.dumps({
        "providers": {"gemini_live": {"enabled": True, "api_key": "real-secret-key"}}
    }), encoding="utf-8")

    result = call_api(tmp_path, "/api/voice-config")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["providers"]["gemini_live"]["enabled"] is True
    assert data["providers"]["gemini_live"]["api_key"] == "[REDACTED]"
    assert "real-secret-key" not in result.stdout


def test_voice_provider_toggle_api_updates_enabled_only(tmp_path):
    result = call_api(
        tmp_path,
        "/api/voice-config/providers/gemini_live",
        method="POST",
        payload={"enabled": True, "api_key": "must-not-save"},
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "saved"
    assert data["provider"] == "gemini_live"
    assert data["providers"]["gemini_live"]["enabled"] is True
    saved = json.loads((tmp_path / "config" / "voice.local.json").read_text(encoding="utf-8"))
    assert saved["providers"]["gemini_live"] == {"enabled": True}
    assert "must-not-save" not in json.dumps(saved)


def test_voice_provider_toggle_rejects_unknown_provider(tmp_path):
    result = call_api(
        tmp_path,
        "/api/voice-config/providers/unknown_provider",
        method="POST",
        payload={"enabled": True},
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["error"] == "unknown_voice_provider"
