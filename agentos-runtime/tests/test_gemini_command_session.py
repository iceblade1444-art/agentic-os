import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_voice_config(workspace: Path):
    config_dir = workspace / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "voice.json").write_text(json.dumps({
        "default_provider": "gemini_live",
        "providers": {
            "gemini_live": {
                "enabled": True,
                "allow_env_credentials": True,
                "mode": "voice_to_voice",
                "model": "gemini-live-3.1",
                "transport": "websocket_or_sdk",
                "api_key_env": "GEMINI_API_KEY",
                "fallback_api_key_env": "GOOGLE_API_KEY"
            }
        }
    }), encoding="utf-8")


def run_cli(workspace: Path, *args, env=None):
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True, env=merged_env)


def call_api(workspace: Path, path: str, method="GET", payload=None, env=None):
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, env=merged_env)


def test_agentosctl_voice_session_gemini_normalizes_to_digest_and_writes_transcript(tmp_path):
    write_voice_config(tmp_path)
    env = {
        "GEMINI_API_KEY": "test-key",
        "AGENTOS_GEMINI_NORMALIZE_MOCK": "покажи digest",
    }

    result = run_cli(tmp_path, "voice", "session", "--provider", "gemini_live", "--text", "Покажи пожалуйста мой статус по проектам", env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "passed"
    assert data["normalized_text"] == "покажи digest"
    assert data["command"]["intent"] == "show_digest"
    transcript_path = Path(data["transcript"]["path"])
    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    assert transcript["normalized_text"] == "покажи digest"


def test_voice_session_api_gemini_normalizes_to_create_goal(tmp_path):
    write_voice_config(tmp_path)
    env = {
        "GEMINI_API_KEY": "test-key",
        "AGENTOS_GEMINI_NORMALIZE_MOCK": "create goal Check Gemini session",
    }

    result = call_api(tmp_path, "/api/voice-session", method="POST", payload={"provider": "gemini_live", "text": "Создай новый проект для проверки Gemini session"}, env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "passed"
    assert data["normalized_text"].startswith("create goal ")
    assert data["command"]["intent"] == "create_goal"
    assert (tmp_path / "projects" / "check-gemini-session").exists()


def test_voice_session_gemini_exact_safe_command_falls_back_to_raw_text_when_normalizer_drifts(tmp_path):
    write_voice_config(tmp_path)
    env = {
        "GEMINI_API_KEY": "test-key",
        "AGENTOS_GEMINI_NORMALIZE_MOCK": "...",
    }

    result = run_cli(tmp_path, "voice", "session", "--provider", "gemini_live", "--text", "покажи digest", env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "passed"
    assert data["normalized_text"] == "покажи digest"
    assert data["normalization_fallback"] == "raw_command_bridge"
    assert data["command"]["intent"] == "show_digest"
    transcript_path = Path(data["transcript"]["path"])
    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    assert transcript["normalization_fallback"] == "raw_command_bridge"
    assert transcript["command"]["intent"] == "show_digest"


def test_voice_session_api_gemini_exact_safe_command_falls_back_to_raw_text_when_normalizer_drifts(tmp_path):
    write_voice_config(tmp_path)
    env = {
        "GEMINI_API_KEY": "test-key",
        "AGENTOS_GEMINI_NORMALIZE_MOCK": "...",
    }

    result = call_api(tmp_path, "/api/voice-session", method="POST", payload={"provider": "gemini_live", "text": "покажи digest"}, env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "passed"
    assert data["normalized_text"] == "покажи digest"
    assert data["normalization_fallback"] == "raw_command_bridge"
    assert data["command"]["intent"] == "show_digest"


def test_voice_session_gemini_reports_unknown_for_unsupported_request(tmp_path):
    write_voice_config(tmp_path)
    env = {
        "GEMINI_API_KEY": "test-key",
        "AGENTOS_GEMINI_NORMALIZE_MOCK": "unknown",
    }

    result = run_cli(tmp_path, "voice", "session", "--provider", "gemini_live", "--text", "Включи музыку", env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "failed"
    assert data["normalized_text"] == "unknown"
    assert data["command"]["intent"] == "unknown"


def test_dashboard_contains_gemini_session_panel():
    text = INDEX.read_text(encoding="utf-8")
    assert "Gemini Command Session" in text
    assert "geminiSessionText" in text
    assert "runGeminiSession" in text
    assert "/api/voice-session" in text
