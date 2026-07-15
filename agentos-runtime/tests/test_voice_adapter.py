import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOICE = ROOT / "scripts" / "voice_command.py"


def run_voice(tmp_path, *args):
    return subprocess.run([sys.executable, str(VOICE), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_voice_adapter_text_command_creates_goal(tmp_path):
    result = run_voice(tmp_path, "--text", "создай goal Voice adapter demo", "--mock-server")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["transport"] == "mock-server"
    assert data["command"]["intent"] == "create_goal"
    assert data["spoken_response"].startswith("Готово")
    assert (tmp_path / "voice" / "last_response.txt").exists()


def test_voice_adapter_file_input_digest(tmp_path):
    input_path = tmp_path / "voice_input.txt"
    input_path.write_text("покажи digest", encoding="utf-8")

    result = run_voice(tmp_path, "--input-file", str(input_path), "--mock-server")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["command"]["intent"] == "show_digest"
    assert "дайджест" in data["spoken_response"].lower()


def test_voice_adapter_rejects_empty_input(tmp_path):
    result = run_voice(tmp_path, "--text", "", "--mock-server")

    assert result.returncode != 0
    assert "empty voice command" in result.stderr


def test_voice_adapter_optional_tts_command_writes_audio_placeholder(tmp_path):
    tts_script = tmp_path / "fake_tts.py"
    tts_script.write_text(
        "import pathlib, sys\npathlib.Path(sys.argv[2]).write_text(sys.argv[1], encoding='utf-8')\n",
        encoding="utf-8",
    )
    output_path = tmp_path / "response.txt"
    result = run_voice(
        tmp_path,
        "--text",
        "создай goal TTS hook demo",
        "--mock-server",
        "--tts-command",
        f"{sys.executable} {tts_script} {{text}} {{output}}",
        "--tts-output",
        str(output_path),
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["tts"]["status"] == "created"
    assert output_path.exists()
    assert "Готово" in output_path.read_text(encoding="utf-8")
