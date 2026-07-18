import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_voice_config(workspace: Path) -> Path:
    config_dir = workspace / "config"
    voice_dir = workspace / "voice"
    config_dir.mkdir(parents=True)
    voice_dir.mkdir(parents=True)
    input_file = voice_dir / "input.txt"
    input_file.write_text("покажи digest\n", encoding="utf-8")
    (config_dir / "voice.json").write_text(json.dumps({
        "default_provider": "mock_text",
        "providers": {
            "mock_text": {"enabled": True, "mode": "text_to_command"},
            "local_file": {"enabled": True, "mode": "file_to_command", "input_file": str(input_file)},
            "gemini_live": {
                "enabled": False,
                "mode": "voice_to_voice",
                "api_key_env": "GEMINI_API_KEY",
                "fallback_api_key_env": "GOOGLE_API_KEY",
                "model": "gemini-live-3.1"
            }
        }
    }), encoding="utf-8")
    return input_file


def run_cli(workspace: Path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True)


def call_api(workspace: Path, path: str, payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method='POST', payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_agentosctl_voice_test_mock_text_routes_through_command_bridge(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "test", "--provider", "mock_text", "--text", "покажи digest")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "mock_text"
    assert data["status"] == "passed"
    assert data["recognized_text"] == "покажи digest"
    assert data["command"]["intent"] == "show_digest"


def test_agentosctl_voice_test_local_file_reads_input_file(tmp_path):
    input_file = write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "test", "--provider", "local_file")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "local_file"
    assert data["status"] == "passed"
    assert data["input_file"] == str(input_file)
    assert data["command"]["intent"] == "show_digest"


def test_relative_local_file_path_resolves_from_workspace_for_cli_and_api(tmp_path):
    input_file = write_voice_config(tmp_path)
    config_path = tmp_path / "config" / "voice.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["providers"]["local_file"]["input_file"] = "voice/input.txt"
    config_path.write_text(json.dumps(config), encoding="utf-8")

    cli_result = run_cli(tmp_path, "voice", "test", "--provider", "local_file")
    api_result = call_api(tmp_path, "/api/voice-test/providers/local_file")

    assert cli_result.returncode == 0, cli_result.stderr
    assert api_result.returncode == 0, api_result.stderr
    assert json.loads(cli_result.stdout)["input_file"] == str(input_file)
    assert json.loads(api_result.stdout)["input_file"] == str(input_file)


def test_agentosctl_voice_test_gemini_live_returns_blocked_when_not_ready(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "test", "--provider", "gemini_live")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "gemini_live"
    assert data["status"] == "blocked"
    assert "disabled" in data["reasons"]
    assert "missing_credentials" in data["reasons"]


def test_voice_provider_test_api_matches_cli_behavior(tmp_path):
    write_voice_config(tmp_path)

    result = call_api(tmp_path, "/api/voice-test/providers/mock_text", {"text": "покажи digest"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "mock_text"
    assert data["status"] == "passed"
    assert data["command"]["intent"] == "show_digest"


def test_dashboard_contains_voice_provider_test_buttons():
    text = INDEX.read_text(encoding="utf-8")
    assert "Test provider" in text
    assert "testVoiceProvider" in text
    assert "voice-test/providers" in text
    assert "id=\"voiceTestResult\"" in text
