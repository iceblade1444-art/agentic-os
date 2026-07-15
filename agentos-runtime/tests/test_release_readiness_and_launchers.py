import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(*args):
    return subprocess.run([sys.executable, str(CLI), *args], text=True, capture_output=True)


def test_agentosctl_release_check_reports_local_ready_state():
    result = run_cli("release", "check")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ready_local"
    assert data["dashboard_url"] == "http://127.0.0.1:8765/"
    assert data["checks"]["dashboard_backend"] is True
    assert data["checks"]["dashboard_frontend"] is True
    assert data["checks"]["command_bridge"] is True
    assert data["checks"]["voice_loop"] is True
    assert data["checks"]["transcript_filters"] is True
    expected_optional_blockers = [] if data["gemini_live"]["ready"] else ["gemini_live"]
    assert data["optional_blockers"] == expected_optional_blockers


def test_launcher_scripts_exist_and_reference_safe_commands():
    expected = {
        "scripts/start_dashboard.sh": "dashboard/backend/app.py",
        "scripts/start_voice_loop.sh": "voice loop --provider local_file --cycles",
        "scripts/start_dashboard.bat": "dashboard\\backend\\app.py",
        "scripts/start_voice_loop.bat": "voice loop --provider local_file --cycles",
    }
    for rel, marker in expected.items():
        path = ROOT / rel
        assert path.exists(), rel
        text = path.read_text(encoding="utf-8")
        assert marker in text
        assert "GEMINI_API_KEY" not in text
        assert "GOOGLE_API_KEY" not in text


def test_readme_contains_release_quickstart():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "Release quickstart" in readme
    assert "start_dashboard" in readme
    assert "agentosctl.py release check" in readme
    assert "voice loop --provider local_file" in readme


def test_release_check_picks_highest_wave_report(tmp_path):
    workspace = tmp_path / "AgentOS"
    for rel in ["dashboard/backend", "dashboard/frontend", "logs/daily", "projects", "artifacts", "approvals", "drafts", "exports/kanban", "scripts", "cron", "agents", "workflows", "memory", "sops"]:
        (workspace / rel).mkdir(parents=True, exist_ok=True)
    (workspace / "dashboard/backend/app.py").write_text("/api/command approval_required create_real_kanban_tasks", encoding="utf-8")
    (workspace / "dashboard/frontend/index.html").write_text("Command Bridge voiceTranscriptProvider", encoding="utf-8")
    (workspace / "agentosctl.py").write_text("def voice_loop():\n    pass\nvoice transcripts\n", encoding="utf-8")
    (workspace / "config").mkdir(parents=True, exist_ok=True)
    (workspace / "config/voice.json").write_text(json.dumps({"providers": {"gemini_live": {"enabled": False, "mode": "voice_to_voice", "model": "gemini-live-3.1", "api_key_env": "GEMINI_API_KEY"}}}), encoding="utf-8")
    (workspace / "logs/daily/2026-06-16_agentos-wave-9-report.md").write_text("w9", encoding="utf-8")
    (workspace / "logs/daily/2026-06-16_agentos-wave-10-report.md").write_text("w10", encoding="utf-8")
    (workspace / "logs/daily/2026-06-16_agentos-wave-21-report.md").write_text("w21", encoding="utf-8")

    result = run_cli("--workspace", str(workspace), "release", "check")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["latest_report"].endswith("wave-21-report.md")
