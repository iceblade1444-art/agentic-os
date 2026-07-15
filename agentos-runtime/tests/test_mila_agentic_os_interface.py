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


def test_dashboard_has_agentic_os_video_inspired_navigation_and_surfaces():
    text = INDEX.read_text(encoding="utf-8")

    required_markers = [
        "Agentic OS Command Center",
        "agenticOsShell",
        "agenticSidebar",
        "data-agent-tab=\"mila\"",
        "data-agent-tab=\"agents\"",
        "data-agent-tab=\"memory\"",
        "data-agent-tab=\"builder\"",
        "data-agent-tab=\"kanban\"",
        "data-agent-tab=\"models\"",
        "milaAgentDock",
        "milaMemoryGalaxy",
        "milaAppBuilder",
        "milaKanbanStudio",
        "milaModelHub",
        "milaPreviewStage",
        "agenticTabButton",
        "activateAgenticTab",
    ]
    for marker in required_markers:
        assert marker in text


def test_agentic_os_visual_language_references_video_takeaways():
    text = INDEX.read_text(encoding="utf-8")

    for phrase in [
        "whole team of AI workers",
        "Obsidian memory galaxy",
        "plug in new models",
        "voice-activated agent",
        "Kanban board",
        "app builder",
        "daily changelog",
        "preview stage",
    ]:
        assert phrase in text


def test_mila_interface_blueprint_endpoint_is_read_only_and_secret_safe():
    data = call_api("/api/mila/interface-blueprint")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_agentic_os_interface_blueprint"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["source_video"]["video_id"] == "A75zZTFw_o0"
    assert "Agentic OS" in data["source_video"]["title"]
    assert data["layout"]["shell"] == "agenticOsShell"
    assert {"agents", "memory", "builder", "kanban", "models", "voice"}.issubset(set(data["modules"]))
    assert "GEMINI_API_KEY" not in json.dumps(data, ensure_ascii=False)
    assert "GOOGLE_API_KEY" not in json.dumps(data, ensure_ascii=False)


def test_release_check_tracks_agentic_os_interface():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_agentic_os_interface"] is True
    assert data["checks"]["mila_realtime_ux"] is True
    assert data["checks"]["mila_desktop_packaging"] is True


def test_readme_mentions_agentic_os_video_ui_direction():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Agentic OS video-inspired interface" in text
    assert "A75zZTFw_o0" in text
    assert "Agentic OS Command Center" in text
