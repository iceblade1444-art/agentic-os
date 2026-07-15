import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"
PTT = ROOT / "scripts" / "push_to_talk.py"


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


def run_ptt(workspace: Path, *args, env=None):
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run([sys.executable, str(PTT), "--workspace", str(workspace), *args], text=True, capture_output=True, env=merged_env)


def test_agentosctl_voice_test_gemini_live_uses_safe_probe_mock(tmp_path):
    write_voice_config(tmp_path)
    env = {"GEMINI_API_KEY": "test-key", "AGENTOS_GEMINI_PROBE_MOCK": "AGENTOS_GEMINI_OK"}

    result = run_cli(tmp_path, "voice", "test", "--provider", "gemini_live", env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "passed"
    assert data["probe_response"] == "AGENTOS_GEMINI_OK"
    assert data["ready"] is True
    assert "test-key" not in result.stdout


def test_voice_test_api_gemini_live_uses_safe_probe_mock(tmp_path):
    write_voice_config(tmp_path)
    env = {"GEMINI_API_KEY": "test-key", "AGENTOS_GEMINI_PROBE_MOCK": "AGENTOS_GEMINI_OK"}

    result = call_api(tmp_path, "/api/voice-test/providers/gemini_live", method="POST", payload={}, env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "passed"
    assert data["probe_response"] == "AGENTOS_GEMINI_OK"
    assert "test-key" not in result.stdout


def test_push_to_talk_gemini_live_can_route_mock_recognition_through_command_bridge(tmp_path):
    write_voice_config(tmp_path)
    env = {
        "GEMINI_API_KEY": "test-key",
        "AGENTOS_GEMINI_RECOGNIZE_MOCK": "покажи digest",
    }

    result = run_ptt(tmp_path, "--provider", "gemini_live", "--once", "--mock-server", env=env)

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["recognized_text"] == "покажи digest"
    assert data["voice_result"]["command"]["intent"] == "show_digest"


def test_dashboard_contains_gemini_live_env_only_hint():
    text = INDEX.read_text(encoding="utf-8")
    assert "GEMINI_API_KEY" in text
    assert "push_to_talk.py --provider gemini_live --status" in text
    assert "browser never stores API keys" in text
    assert ".env" in text


def test_push_to_talk_status_merges_voice_local_overlay(tmp_path):
    write_voice_config(tmp_path)
    (tmp_path / "config" / "voice.json").write_text(json.dumps({
        "default_provider": "gemini_live",
        "providers": {
            "gemini_live": {
                "enabled": False,
                "allow_env_credentials": True,
                "mode": "voice_to_voice",
                "model": "gemini-live-3.1",
                "transport": "websocket_or_sdk",
                "api_key_env": "GEMINI_API_KEY",
                "fallback_api_key_env": "GOOGLE_API_KEY"
            }
        }
    }), encoding="utf-8")
    (tmp_path / "config" / "voice.local.json").write_text(json.dumps({"providers": {"gemini_live": {"enabled": True, "allow_env_credentials": True}}}), encoding="utf-8")

    result = run_ptt(tmp_path, "--provider", "gemini_live", "--status", env={"GEMINI_API_KEY": "test-key"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["enabled"] is True
    assert data["ready"] is True
