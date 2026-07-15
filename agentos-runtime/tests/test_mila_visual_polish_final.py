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


def test_visual_polish_endpoint_describes_final_jarvis_workspace():
    data = call_api("/api/mila/visual-polish")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_jarvis_workspace_visual_polish"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["layout"]["mode"] == "focused_command_center"
    assert data["layout"]["routes"] >= 9
    assert "voice_first" in data["principles"]
    assert "approval_gated_actions" in data["principles"]
    assert "no_secret_surfaces" in data["principles"]
    assert len(data["polish_markers"]) >= 6
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob


def test_frontend_has_final_visual_polish_markers():
    text = INDEX.read_text(encoding="utf-8")
    required = [
        "milaJarvisWorkspace",
        "jarvis-focus-strip",
        "jarvis-live-signal",
        "jarvis-safety-ribbon",
        "jarvis-workspace-lanes",
        "milaVisualPolishPanel",
        "loadMilaVisualPolish",
        "renderMilaVisualPolish",
        "/api/mila/visual-polish",
        "focused command center",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_visual_polish_completion():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_visual_polish_final"] is True
    assert data["checks"]["mila_native_tray_scaffold"] is True


def test_readme_mentions_phase_8_visual_polish():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila Jarvis visual polish" in text
    assert "/api/mila/visual-polish" in text
    assert "focused command center" in text
