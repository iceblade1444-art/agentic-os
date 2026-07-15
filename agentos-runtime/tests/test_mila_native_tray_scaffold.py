import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"
CLI = ROOT / "agentosctl.py"
TRAY_SCRIPT = ROOT / "scripts" / "mila_tray.py"
TRAY_BAT = ROOT / "scripts" / "start_mila_tray.bat"


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


def test_tray_package_endpoint_is_safe_and_lists_scripts():
    data = call_api("/api/mila/tray-package")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_native_tray_package_scaffold"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["capabilities"] == ["open_dashboard", "status", "restart_dashboard", "quit"]
    relpaths = [item["relpath"] for item in data["scripts"]]
    assert "scripts/mila_tray.py" in relpaths
    assert "scripts/start_mila_tray.bat" in relpaths
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob
    assert "api_key" not in blob.lower()


def test_tray_scaffold_files_exist_and_are_secret_free():
    assert TRAY_SCRIPT.exists()
    assert TRAY_BAT.exists()
    script = TRAY_SCRIPT.read_text(encoding="utf-8")
    bat = TRAY_BAT.read_text(encoding="utf-8")

    for text in [script, bat]:
        assert "8765" in text
        assert "open_dashboard" in text or "open dashboard" in text.lower()
        assert "GEMINI_API_KEY" not in text
        assert "GOOGLE_API_KEY" not in text
        assert "api_key" not in text.lower()
    assert "pystray" in script or "webbrowser" in script
    assert "restart_dashboard" in script


def test_frontend_exposes_tray_package_controls():
    text = INDEX.read_text(encoding="utf-8")
    required = [
        "milaTrayPackagePanel",
        "milaTrayPackageResult",
        "loadMilaTrayPackage",
        "renderMilaTrayPackage",
        "/api/mila/tray-package",
        "Native tray package",
        "Open dashboard",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_native_tray_scaffold():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_native_tray_scaffold"] is True
    assert data["checks"]["mila_model_hub_live"] is True


def test_readme_mentions_phase_7_native_tray():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila native tray scaffold" in text
    assert "/api/mila/tray-package" in text
    assert "scripts/mila_tray.py" in text
