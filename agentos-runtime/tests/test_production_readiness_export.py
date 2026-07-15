import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


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


def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def seed_release_ready_workspace(workspace: Path, *, gemini_ready=False):
    write(workspace / "dashboard" / "backend" / "app.py", "/api/command /api/voice-loop /api/mila/desktop-package /api/mila/interface-blueprint /api/mila/dashboard-routes /api/mila/agent-dock /api/mila/memory-galaxy /api/mila/app-builder/blueprint /api/mila/kanban-studio /api/mila/model-hub /api/mila/tray-package /api/mila/visual-polish approval_required create_real_kanban_tasks")
    write(workspace / "dashboard" / "frontend" / "index.html", "Command Bridge voiceTranscriptProvider milaRealtimePanel milaStartListening /api/voice-session agenticOsShell milaMemoryGalaxy milaAppBuilder milaPrimaryRoutes activateMilaRoute syncMilaRouteFromHash milaAgentDockLive loadMilaAgentDock milaMemoryGalaxyLive loadMilaMemoryGalaxy milaAppBuilderIdea loadMilaAppBuilderBlueprint milaKanbanStudioLive loadMilaKanbanStudio milaModelHubLive loadMilaModelHub milaTrayPackagePanel loadMilaTrayPackage milaJarvisWorkspace jarvis-focus-strip loadMilaVisualPolish")
    write(workspace / "agentosctl.py", "def voice_loop():\n    pass\n# voice transcripts\n")
    for rel in ["scripts/start_mila.bat", "scripts/start_mila.sh", "scripts/mila_tray.py", "scripts/start_mila_tray.bat", "installers/install_mila_autostart.bat", "installers/uninstall_mila_autostart.bat"]:
        write(workspace / rel, "Mila launcher template\n")
    write(workspace / "logs" / "daily" / "2026-06-17_agentos-wave-76-report.md", "# Wave 76\nverified\n")
    voice_provider = {
        "enabled": True,
        "allow_env_credentials": True,
        "mode": "voice_to_voice",
        "model": "gemini-live-3.1",
        "api_key_env": "AGENTOS_TEST_GEMINI_KEY_READY_EXPORT" if gemini_ready else "AGENTOS_TEST_GEMINI_KEY_MISSING_EXPORT",
    }
    if gemini_ready:
        os.environ["AGENTOS_TEST_GEMINI_KEY_READY_EXPORT"] = "test-key"
    write(workspace / "config" / "voice.json", json.dumps({"providers": {"gemini_live": voice_provider}}, indent=2))
    write(workspace / "config" / "agent-worker.json", json.dumps({"enabled": False, "runtime_mode": "dry_run", "dry_run": True, "filters": {}}, indent=2))


def test_production_readiness_export_preview_returns_bounded_markdown_and_is_read_only(tmp_path):
    seed_release_ready_workspace(tmp_path, gemini_ready=False)
    before_config = (tmp_path / "config" / "agent-worker.json").read_text(encoding="utf-8")

    result = call_api(tmp_path, "/api/production-readiness/export?max_chars=500")

    assert result["status"] == "ok"
    assert result["decision"] == "production_readiness_export_preview"
    assert result["dry_run"] is True
    assert result["will_apply"] is False
    assert result["writes_enabled"] is False
    assert result["artifact_path"] is None
    assert result["artifact_relpath"] is None
    assert result["readiness"]["status"] == "ready_with_optional_blockers"
    preview = result["export_preview"]
    assert preview["format"] == "markdown"
    assert preview["title"] == "AgentOS Production Readiness"
    assert preview["max_chars"] == 500
    assert preview["content_length"] >= len(preview["markdown_preview"])
    assert preview["line_count"] > 10
    assert "# AgentOS Production Readiness" in preview["markdown_preview"]
    assert "ready_with_optional_blockers" in preview["markdown_preview"]
    assert "optional_blockers" in preview["markdown_preview"]
    assert "gemini_live" in preview["markdown_preview"]
    assert "required_blockers" in preview["markdown_preview"]
    assert preview["redactions"] == ["api_key", "token", "secret", "password"]
    assert result["safety"] == {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "retention_apply_called": False,
        "operational_ledgers_mutated": False,
    }
    assert result["links"]["production_readiness"] == "/api/production-readiness"
    assert (tmp_path / "config" / "agent-worker.json").read_text(encoding="utf-8") == before_config


def test_production_readiness_export_preview_full_content_and_dashboard_markers(tmp_path):
    seed_release_ready_workspace(tmp_path, gemini_ready=True)
    result = call_api(tmp_path, "/api/production-readiness/export?max_chars=0")

    assert result["status"] == "ok"
    assert result["readiness"]["status"] == "ready_local"
    assert result["export_preview"]["max_chars"] == 0
    assert result["export_preview"]["truncated"] is False
    assert "ready_for_local_production_run" in result["export_preview"]["markdown_preview"]

    text = INDEX.read_text(encoding="utf-8")
    assert "loadProductionReadinessExportPreview" in text
    assert "/api/production-readiness/export?max_chars=1600" in text
    assert "production_readiness_export_preview" in text
    assert "markdown_preview" in text
    assert "Export readiness preview" in text
