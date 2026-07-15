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
    (config_dir / "voice.json").write_text(json.dumps({
        "default_provider": "mock_text",
        "providers": {
            "mock_text": {"enabled": True, "mode": "text_to_command"},
            "local_file": {"enabled": True, "mode": "file_to_command", "input_file": str(input_file)},
            "gemini_live": {"enabled": False, "mode": "voice_to_voice", "api_key_env": "GEMINI_API_KEY"}
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


def test_agentosctl_voice_sample_writes_local_file_and_makes_provider_ready(tmp_path):
    input_file = write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "sample", "--text", "покажи digest")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "sample_written"
    assert data["provider"] == "local_file"
    assert data["input_file"] == str(input_file)
    assert input_file.read_text(encoding="utf-8").strip() == "покажи digest"

    status = json.loads(run_cli(tmp_path, "voice", "status").stdout)
    local = next(item for item in status["providers"] if item["provider"] == "local_file")
    assert local["ready"] is True


def test_agentosctl_voice_sample_then_local_file_test_passes(tmp_path):
    write_voice_config(tmp_path)
    run_cli(tmp_path, "voice", "sample", "--text", "покажи digest")

    result = run_cli(tmp_path, "voice", "test", "--provider", "local_file")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["provider"] == "local_file"
    assert data["status"] == "passed"
    assert data["recognized_text"] == "покажи digest"
    assert data["command"]["intent"] == "show_digest"


def test_voice_sample_api_writes_local_file(tmp_path):
    input_file = write_voice_config(tmp_path)

    result = call_api(tmp_path, "/api/voice-sample", {"text": "покажи digest"})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "sample_written"
    assert data["input_file"] == str(input_file)
    assert input_file.read_text(encoding="utf-8").strip() == "покажи digest"


def test_voice_sample_rejects_empty_text(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "sample", "--text", "")

    assert result.returncode != 0
    assert "text_required" in result.stderr


def test_dashboard_contains_voice_sample_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "Write local-file sample" in text
    assert "writeVoiceSample" in text
    assert "voice-sample" in text
    assert "id=\"voiceSampleText\"" in text
