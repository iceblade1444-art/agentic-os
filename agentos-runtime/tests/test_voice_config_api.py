import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(tmp_path)!r}, {path!r}, method={method!r}, payload={repr(payload)}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_voice_config_api_exposes_gemini_live(tmp_path):
    result = call_api(tmp_path, "/api/voice-config")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert "gemini_live" in data["providers"]
    assert data["providers"]["gemini_live"]["mode"] == "voice_to_voice"
