import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOICE_CONFIG = ROOT / "config" / "voice.json"
PTT = ROOT / "scripts" / "push_to_talk.py"


def test_voice_config_contains_gemini_live_profile():
    data = json.loads(VOICE_CONFIG.read_text(encoding="utf-8"))
    assert data["default_provider"] in data["providers"]
    gemini = data["providers"]["gemini_live"]
    assert gemini["mode"] == "voice_to_voice"
    assert "model" in gemini
    assert gemini["api_key_env"] in {"GEMINI_API_KEY", "GOOGLE_API_KEY"}
    assert gemini["enabled"] is True
    assert gemini["allow_env_credentials"] is True


def run_ptt(tmp_path, *args):
    return subprocess.run([sys.executable, str(PTT), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_push_to_talk_mock_routes_text_to_voice_adapter(tmp_path):
    result = run_ptt(tmp_path, "--mock-text", "создай goal Push to talk demo", "--mock-server", "--once")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "mock_text"
    assert data["voice_result"]["command"]["intent"] == "create_goal"


def test_push_to_talk_gemini_live_requires_key_unless_mock(tmp_path):
    result = run_ptt(tmp_path, "--provider", "gemini_live", "--once")
    assert result.returncode != 0
    assert (
        "requires GEMINI_API_KEY" in result.stderr
        or "requires GOOGLE_API_KEY" in result.stderr
        or "gemini_live realtime SDK/WebSocket transport is not wired yet" in result.stderr
    )
