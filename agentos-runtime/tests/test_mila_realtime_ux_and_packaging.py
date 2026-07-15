import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"
CLI = ROOT / "agentosctl.py"


def call_api(path: str):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(ROOT)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, cwd=str(ROOT))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_mila_realtime_voice_console_is_present_in_dashboard():
    text = INDEX.read_text(encoding="utf-8")
    required_markers = [
        "Мила",
        "milaRealtimePanel",
        "milaStartListening",
        "milaStopListening",
        "milaSubmitUtterance",
        "milaTranscriptInput",
        "milaSessionResult",
        "SpeechRecognition",
        "speechSynthesis",
        "approval gates",
        "/api/voice-session",
    ]
    for marker in required_markers:
        assert marker in text


def test_mila_desktop_package_endpoint_is_read_only_and_redacted():
    data = call_api("/api/mila/desktop-package")

    assert data["status"] == "ok"
    assert data["app_name"] == "Mila"
    assert data["dashboard_url"] == "http://127.0.0.1:8765/"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["autostart"]["startup_entry"] == "Mila AgentOS.cmd"
    assert data["scripts"]["start_windows"].endswith("scripts/start_mila.bat")
    assert data["scripts"]["install_autostart_windows"].endswith("installers/install_mila_autostart.bat")
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob


def test_mila_launcher_and_autostart_scripts_are_safe_templates():
    expected = {
        "scripts/start_mila.bat": ["Mila AgentOS", "dashboard\\backend\\app.py", "http://127.0.0.1:%PORT%/"],
        "scripts/start_mila.sh": ["Mila AgentOS", "dashboard/backend/app.py", "http://127.0.0.1:${PORT}/"],
        "installers/install_mila_autostart.bat": ["Startup", "Mila AgentOS.cmd", "start_mila.bat"],
        "installers/uninstall_mila_autostart.bat": ["Startup", "Mila AgentOS.cmd", "del"],
    }
    for rel, markers in expected.items():
        path = ROOT / rel
        assert path.exists(), rel
        text = path.read_text(encoding="utf-8")
        for marker in markers:
            assert marker in text
        assert "GEMINI_API_KEY" not in text
        assert "GOOGLE_API_KEY" not in text
        assert "AIza" not in text


def test_release_check_tracks_mila_realtime_and_packaging():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_realtime_ux"] is True
    assert data["checks"]["mila_desktop_packaging"] is True
    assert data["status"] == "ready_local"


def test_readme_has_mila_desktop_quickstart():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila desktop quickstart" in text
    assert "scripts\\start_mila.bat" in text
    assert "install_mila_autostart.bat" in text
    assert ".env" in text
