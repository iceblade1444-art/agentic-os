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
            "gemini_live": {"enabled": False, "mode": "voice_to_voice", "api_key_env": "GEMINI_API_KEY"}
        }
    }), encoding="utf-8")
    return input_file


def run_cli(workspace: Path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True)


def call_api(workspace: Path, path: str, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def read_single_transcript(workspace: Path) -> dict:
    transcripts = sorted((workspace / "voice" / "transcripts").glob("*.json"))
    assert len(transcripts) == 1
    return json.loads(transcripts[0].read_text(encoding="utf-8"))


def test_agentosctl_voice_loop_once_writes_transcript_for_local_file(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "loop", "--provider", "local_file", "--once")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "loop_completed"
    assert data["provider"] == "local_file"
    assert data["cycles"] == 1
    assert len(data["transcripts"]) == 1

    transcript = read_single_transcript(tmp_path)
    assert transcript["provider"] == "local_file"
    assert transcript["recognized_text"] == "покажи digest"
    assert transcript["command"]["intent"] == "show_digest"
    assert transcript["status"] == "passed"


def test_agentosctl_voice_loop_blocks_unready_gemini_and_writes_transcript(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "loop", "--provider", "gemini_live", "--once")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "loop_completed"
    transcript = read_single_transcript(tmp_path)
    assert transcript["provider"] == "gemini_live"
    assert transcript["status"] == "blocked"
    assert "missing_credentials" in transcript["reasons"]


def test_voice_loop_api_and_transcripts_api(tmp_path):
    write_voice_config(tmp_path)

    loop = call_api(tmp_path, "/api/voice-loop", method="POST", payload={"provider": "local_file", "once": True})
    assert loop.returncode == 0, loop.stderr
    loop_data = json.loads(loop.stdout)
    assert loop_data["status"] == "loop_completed"
    assert loop_data["transcripts"][0]["provider"] == "local_file"

    listed = call_api(tmp_path, "/api/voice-transcripts", method="GET")
    assert listed.returncode == 0, listed.stderr
    transcripts = json.loads(listed.stdout)
    assert transcripts["count"] == 1
    assert transcripts["items"][0]["provider"] == "local_file"
    assert transcripts["items"][0]["command"]["intent"] == "show_digest"


def test_dashboard_contains_voice_transcripts_panel():
    text = INDEX.read_text(encoding="utf-8")
    assert "Voice Transcripts" in text
    assert "loadVoiceTranscripts" in text
    assert "voice-transcripts" in text
    assert "voice-loop" in text
    assert "id=\"voiceTranscripts\"" in text
