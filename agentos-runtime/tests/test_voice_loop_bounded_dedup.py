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


def test_agentosctl_voice_loop_cycles_deduplicates_unchanged_local_file(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "loop", "--provider", "local_file", "--cycles", "3", "--interval", "0")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "loop_completed"
    assert data["cycles"] == 3
    assert data["processed"] == 1
    assert data["skipped"] == 2
    assert [t["status"] for t in data["transcripts"]] == ["passed", "skipped", "skipped"]
    assert data["transcripts"][0]["command"]["intent"] == "show_digest"
    assert "command" not in data["transcripts"][1]


def test_voice_loop_api_cycles_deduplicates_and_transcripts_api_lists_skips(tmp_path):
    write_voice_config(tmp_path)

    result = call_api(tmp_path, "/api/voice-loop", method="POST", payload={"provider": "local_file", "cycles": 3, "interval": 0})

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["processed"] == 1
    assert data["skipped"] == 2

    listed = call_api(tmp_path, "/api/voice-transcripts", method="GET")
    transcripts = json.loads(listed.stdout)
    assert transcripts["count"] == 3
    statuses = [item["status"] for item in transcripts["items"]]
    assert statuses.count("passed") == 1
    assert statuses.count("skipped") == 2


def test_agentosctl_voice_loop_rejects_unbounded_loop_without_cycles_or_once(tmp_path):
    write_voice_config(tmp_path)

    result = run_cli(tmp_path, "voice", "loop", "--provider", "local_file")

    assert result.returncode != 0
    assert "cycles_or_once_required" in result.stderr


def test_dashboard_contains_bounded_voice_loop_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "voiceLoopCycles" in text
    assert "voiceLoopInterval" in text
    assert "runVoiceLoop" in text
    assert "cycles" in text
    assert "processed" in text
    assert "skipped" in text
