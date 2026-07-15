import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_voice_config(workspace: Path) -> None:
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


def make_transcripts(workspace: Path):
    write_voice_config(workspace)
    run_cli(workspace, "voice", "loop", "--provider", "local_file", "--once")
    run_cli(workspace, "voice", "loop", "--provider", "gemini_live", "--once")


def test_agentosctl_voice_transcripts_filters_by_provider_status_and_query(tmp_path):
    make_transcripts(tmp_path)

    result = run_cli(tmp_path, "voice", "transcripts", "--provider", "local_file", "--status", "passed", "--query", "digest", "--limit", "5")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["count"] == 1
    item = data["items"][0]
    assert item["provider"] == "local_file"
    assert item["status"] == "passed"
    assert item["command"]["intent"] == "show_digest"


def test_voice_transcripts_api_filters_by_provider_status_and_query(tmp_path):
    make_transcripts(tmp_path)

    result = call_api(tmp_path, "/api/voice-transcripts?provider=gemini_live&status=blocked&q=missing_credentials&limit=5")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["count"] == 1
    assert data["items"][0]["provider"] == "gemini_live"
    assert data["items"][0]["status"] == "blocked"
    assert "missing_credentials" in data["items"][0]["reasons"]


def test_dashboard_contains_voice_transcript_filter_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "voiceTranscriptProvider" in text
    assert "voiceTranscriptStatus" in text
    assert "voiceTranscriptSearch" in text
    assert "voiceTranscriptLimit" in text
    assert "loadVoiceTranscripts" in text
