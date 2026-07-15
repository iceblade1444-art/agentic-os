import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVIDER = ROOT / "voice" / "providers" / "gemini_live.py"
PTT = ROOT / "scripts" / "push_to_talk.py"
EXAMPLE = ROOT / "config" / "voice.local.example.json"


def load_provider_module():
    spec = importlib.util.spec_from_file_location("gemini_live_provider", PROVIDER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_gemini_live_provider_status_without_key_is_not_ready(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    module = load_provider_module()
    status = module.provider_status({"api_key_env": "GEMINI_API_KEY", "fallback_api_key_env": "GOOGLE_API_KEY", "enabled": False})
    assert status["provider"] == "gemini_live"
    assert status["ready"] is False
    assert "GEMINI_API_KEY" in status["missing"]


def test_gemini_live_provider_never_leaks_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "secret-test-key")
    module = load_provider_module()
    status = module.provider_status({"api_key_env": "GEMINI_API_KEY", "allow_env_credentials": True, "enabled": True, "model": "gemini-live-3.1"})
    blob = json.dumps(status)
    assert "secret-test-key" not in blob
    assert status["has_key"] is True


def test_voice_local_example_has_no_inline_secret_and_points_to_dotenv():
    data = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    gemini = data["providers"]["gemini_live"]
    assert "api_key" not in gemini
    assert gemini["api_key_env"] == "GEMINI_API_KEY"
    assert gemini["fallback_api_key_env"] == "GOOGLE_API_KEY"
    assert gemini["enabled"] is False
    assert ".env" in data["description"]


def test_push_to_talk_provider_status_command(tmp_path):
    result = subprocess.run(
        [sys.executable, str(PTT), "--workspace", str(tmp_path), "--provider", "gemini_live", "--status"],
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert "ready" in data
    assert "secret" not in result.stdout.lower()
