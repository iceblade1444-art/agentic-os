import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
SECRET = "agentos-super-secret-value-12345"


def call_api(workspace: Path, path: str):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def seed_secret_surfaces(workspace: Path):
    (workspace / "config").mkdir(parents=True, exist_ok=True)
    (workspace / "logs").mkdir(parents=True, exist_ok=True)
    (workspace / "dashboard" / "backend").mkdir(parents=True, exist_ok=True)
    (workspace / "dashboard" / "frontend").mkdir(parents=True, exist_ok=True)
    (workspace / "agentosctl.py").write_text("def voice_loop():\n    pass\nvoice transcripts\n", encoding="utf-8")
    (workspace / "dashboard" / "backend" / "app.py").write_text(
        "/api/command /api/voice-loop /api/mila/desktop-package /api/mila/interface-blueprint "
        "/api/mila/dashboard-routes /api/mila/agent-dock /api/mila/memory-galaxy "
        "/api/mila/app-builder/blueprint /api/mila/kanban-studio /api/mila/model-hub "
        "/api/mila/tray-package /api/mila/visual-polish approval_required create_real_kanban_tasks",
        encoding="utf-8",
    )
    (workspace / "dashboard" / "frontend" / "index.html").write_text(
        "Command Bridge voiceTranscriptProvider milaRealtimePanel milaStartListening /api/voice-session "
        "agenticOsShell milaMemoryGalaxy milaAppBuilder milaPrimaryRoutes activateMilaRoute "
        "syncMilaRouteFromHash milaAgentDockLive loadMilaAgentDock milaMemoryGalaxyLive "
        "loadMilaMemoryGalaxy milaAppBuilderIdea loadMilaAppBuilderBlueprint milaKanbanStudioLive "
        "loadMilaKanbanStudio milaModelHubLive loadMilaModelHub milaTrayPackagePanel "
        "loadMilaTrayPackage milaJarvisWorkspace jarvis-focus-strip loadMilaVisualPolish "
        "Production Readiness productionReadiness loadProductionReadiness ready_with_optional_blockers "
        "required_blockers Promise.all([loadStatus(), loadProductionReadiness()]) "
        "Dashboard Runtime Diagnostics dashboardRuntimeDiagnostics loadDashboardRuntimeDiagnostics "
        "loadDashboardRuntimeDiagnosticsExportPreview /api/dashboard/runtime-diagnostics "
        "/api/dashboard/runtime-diagnostics/export Export runtime diagnostics preview secrets_redacted",
        encoding="utf-8",
    )
    (workspace / "config" / "voice.json").write_text(
        json.dumps(
            {
                "default_provider": "gemini_live",
                "providers": {
                    "gemini_live": {
                        "enabled": True,
                        "allow_env_credentials": True,
                        "mode": "voice_to_voice",
                        "model": "gemini-live-3.1",
                        "api_key_env": "AGENTOS_SECRET_SCAN_KEY",
                    }
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (workspace / "config" / "voice.local.json").write_text(
        json.dumps({"providers": {"gemini_live": {"enabled": True, "api_key": SECRET}}}, indent=2),
        encoding="utf-8",
    )
    (workspace / "logs" / "events.json").write_text(
        json.dumps(
            [
                {
                    "id": "event_secret",
                    "type": "secret_probe",
                    "actor": "test",
                    "created_at": "2026-06-25T00:00:00",
                    "api_key": SECRET,
                    "note": f"token={SECRET}",
                }
            ],
            indent=2,
        ),
        encoding="utf-8",
    )


def test_dashboard_surfaces_do_not_return_seeded_secret(tmp_path, monkeypatch):
    seed_secret_surfaces(tmp_path)
    monkeypatch.setenv("AGENTOS_SECRET_SCAN_KEY", SECRET)

    endpoints = [
        "/api/voice-config",
        "/api/voice-health",
        "/api/production-readiness",
        "/api/production-readiness/export?max_chars=0",
        "/api/dashboard/runtime-diagnostics",
        "/api/dashboard/runtime-diagnostics/export?max_chars=0",
        "/api/events",
        "/api/events?format=raw",
    ]

    for endpoint in endpoints:
        payload = json.dumps(call_api(tmp_path, endpoint), ensure_ascii=False)
        assert SECRET not in payload, endpoint
        assert "agentos-super-secret-value" not in payload, endpoint
