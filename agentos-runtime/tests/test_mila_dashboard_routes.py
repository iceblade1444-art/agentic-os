import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "dashboard" / "frontend" / "index.html"
APP = ROOT / "dashboard" / "backend" / "app.py"
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


def test_dashboard_has_primary_route_shell_and_route_targets():
    text = INDEX.read_text(encoding="utf-8")

    required = [
        "milaPrimaryRoutes",
        "milaRouteButton",
        "data-mila-route=\"overview\"",
        "data-mila-route=\"voice\"",
        "data-mila-route=\"agents\"",
        "data-mila-route=\"memory\"",
        "data-mila-route=\"builder\"",
        "data-mila-route=\"kanban\"",
        "data-mila-route=\"models\"",
        "data-mila-route=\"runtime\"",
        "data-mila-route=\"projects\"",
        "milaRouteOverview",
        "milaRouteVoice",
        "milaRouteAgents",
        "milaRouteMemory",
        "milaRouteBuilder",
        "milaRouteKanban",
        "milaRouteModels",
        "milaRouteRuntime",
        "milaRouteProjects",
        "activateMilaRoute",
        "syncMilaRouteFromHash",
    ]
    for marker in required:
        assert marker in text


def test_legacy_dashboard_panels_are_assigned_to_routes():
    text = INDEX.read_text(encoding="utf-8")

    route_assignments = {
        "System Status": "milaRouteOverview",
        "Production Readiness": "milaRouteOverview",
        "Мила — realtime voice-to-voice UX": "milaRouteVoice",
        "Voice Adapter": "milaRouteVoice",
        "Voice Transcripts": "milaRouteVoice",
        "Projects": "milaRouteProjects",
        "Approvals": "milaRouteRuntime",
        "Event Log": "milaRouteRuntime",
        "Daily Digest": "milaRouteOverview",
    }
    for label, route_id in route_assignments.items():
        assert label in text
        heading = f"<h2>{label}</h2>"
        label_index = text.find(heading)
        if label_index == -1:
            label_index = text.find(label, text.find(f'id="{route_id}"'))
        route_index = text.rfind(f'id="{route_id}"', 0, label_index)
        assert route_index != -1, f"{label} should appear inside/after {route_id}"


def test_dashboard_route_blueprint_endpoint_is_read_only_and_secret_safe():
    data = call_api("/api/mila/dashboard-routes")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_dashboard_routes"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["default_route"] == "overview"
    assert data["hash_routing"] is True
    assert set(data["routes"]) >= {"overview", "voice", "agents", "memory", "builder", "kanban", "models", "runtime", "projects"}
    assert "GEMINI_API_KEY" not in json.dumps(data, ensure_ascii=False)


def test_release_check_tracks_mila_dashboard_routes():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_dashboard_routes"] is True
    assert data["checks"]["mila_agentic_os_interface"] is True


def test_readme_mentions_phase_1_dashboard_routes():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila dashboard routes" in text
    assert "#voice" in text
    assert "#builder" in text
    assert "#runtime" in text
