import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def call_api(workspace: Path, path: str, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def seed_release_ready_workspace(workspace: Path, *, gemini_ready=False, worker_execute=False):
    write(workspace / "dashboard" / "backend" / "app.py", "/api/command /api/voice-loop /api/mila/desktop-package /api/mila/interface-blueprint /api/mila/dashboard-routes /api/mila/agent-dock /api/mila/memory-galaxy /api/mila/app-builder/blueprint /api/mila/kanban-studio /api/mila/model-hub /api/mila/tray-package /api/mila/visual-polish approval_required create_real_kanban_tasks")
    write(workspace / "dashboard" / "frontend" / "index.html", "Command Bridge voiceTranscriptProvider milaRealtimePanel milaStartListening /api/voice-session agenticOsShell milaMemoryGalaxy milaAppBuilder milaPrimaryRoutes activateMilaRoute syncMilaRouteFromHash milaAgentDockLive loadMilaAgentDock milaMemoryGalaxyLive loadMilaMemoryGalaxy milaAppBuilderIdea loadMilaAppBuilderBlueprint milaKanbanStudioLive loadMilaKanbanStudio milaModelHubLive loadMilaModelHub milaTrayPackagePanel loadMilaTrayPackage milaJarvisWorkspace jarvis-focus-strip loadMilaVisualPolish")
    write(workspace / "agentosctl.py", "def voice_loop():\n    pass\n# voice transcripts\n")
    for rel in ["scripts/start_mila.bat", "scripts/start_mila.sh", "scripts/mila_tray.py", "scripts/start_mila_tray.bat", "installers/install_mila_autostart.bat", "installers/uninstall_mila_autostart.bat"]:
        write(workspace / rel, "Mila launcher template\n")
    write(workspace / "logs" / "daily" / "2026-06-17_agentos-wave-75-report.md", "# Wave 75\nverified\n")
    voice_provider = {
        "enabled": True,
        "allow_env_credentials": True,
        "mode": "voice_to_voice",
        "model": "gemini-live-3.1",
        "api_key_env": "AGENTOS_TEST_GEMINI_KEY_READY" if gemini_ready else "AGENTOS_TEST_GEMINI_KEY_MISSING",
        "fallback_api_key_env": "AGENTOS_TEST_GOOGLE_KEY_READY" if gemini_ready else "AGENTOS_TEST_GOOGLE_KEY_MISSING",
    }
    if gemini_ready:
        os.environ["AGENTOS_TEST_GEMINI_KEY_READY"] = "test-key"
    write(workspace / "config" / "voice.json", json.dumps({"providers": {"gemini_live": voice_provider}}, indent=2))
    if worker_execute:
        config = {"enabled": True, "runtime_mode": "execute", "dry_run": False, "filters": {}}
    else:
        config = {"enabled": False, "runtime_mode": "dry_run", "dry_run": True, "filters": {}}
    write(workspace / "config" / "agent-worker.json", json.dumps(config, indent=2))


def test_production_readiness_reports_ready_with_optional_blockers_and_safe_state(tmp_path):
    seed_release_ready_workspace(tmp_path, gemini_ready=False, worker_execute=False)

    result = call_api(tmp_path, "/api/production-readiness")

    assert result["status"] == "ready_with_optional_blockers"
    assert result["decision"] == "production_readiness"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["read_only"] is True
    assert result["readiness"]["local_ready"] is True
    assert result["readiness"]["production_ready"] is False
    assert result["readiness"]["required_checks_passed"] is True
    assert result["readiness"]["worker_safe_state"] is True
    assert result["required_blockers"] == []
    assert result["optional_blockers"] == ["gemini_live"]
    assert result["release_check"]["status"] == "ready_local"
    assert all(result["release_check"]["checks"].values())
    assert result["latest_report"]["exists"] is True
    assert result["latest_report"]["relpath"] == "logs/daily/2026-06-17_agentos-wave-75-report.md"
    assert result["worker"]["status"] == "disabled"
    assert result["worker"]["runtime"]["mode"] == "dry_run"
    assert "configure_gemini_live_credentials" in result["operator_next_steps"]
    assert result["links"]["release_check"] == "agentosctl.py release check --pretty"


def test_production_readiness_blocks_required_failures_and_unsafe_worker(tmp_path):
    seed_release_ready_workspace(tmp_path, gemini_ready=True, worker_execute=True)
    (tmp_path / "dashboard" / "frontend" / "index.html").unlink()

    result = call_api(tmp_path, "/api/production-readiness")

    assert result["status"] == "blocked"
    assert result["readiness"]["local_ready"] is False
    assert result["readiness"]["production_ready"] is False
    assert result["readiness"]["required_checks_passed"] is False
    assert result["readiness"]["worker_safe_state"] is False
    assert "dashboard_frontend" in result["required_blockers"]
    assert "agent_worker_safe_state" in result["required_blockers"]
    assert result["optional_blockers"] == []
    assert "fix_required_checks" in result["operator_next_steps"]
    assert "reset_worker_to_disabled_dry_run" in result["operator_next_steps"]


def test_dashboard_contains_production_readiness_panel_and_refresh_loader():
    text = INDEX.read_text(encoding="utf-8")
    assert "Production Readiness" in text
    assert "productionReadiness" in text
    assert "loadProductionReadiness" in text
    assert "/api/production-readiness" in text
    assert "ready_with_optional_blockers" in text
    assert "required_blockers" in text
    refresh_line = next(line for line in text.splitlines() if "Promise.all" in line and "loadStatus()" in line)
    assert "loadProductionReadiness()" in refresh_line
