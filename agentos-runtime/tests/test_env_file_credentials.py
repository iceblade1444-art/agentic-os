import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
PTT = ROOT / "scripts" / "push_to_talk.py"


def env_without_gemini(extra=None):
    env = os.environ.copy()
    env.pop("GEMINI_API_KEY", None)
    env.pop("GOOGLE_API_KEY", None)
    if extra:
        env.update(extra)
    return env


def write_voice_config(workspace: Path):
    config_dir = workspace / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "voice.json").write_text(json.dumps({
        "default_provider": "gemini_live",
        "providers": {
            "gemini_live": {
                "enabled": True,
                "allow_env_credentials": True,
                "mode": "voice_to_voice",
                "model": "gemini-live-3.1",
                "transport": "websocket_or_sdk",
                "api_key_env": "GEMINI_API_KEY",
                "fallback_api_key_env": "GOOGLE_API_KEY"
            }
        }
    }, indent=2), encoding="utf-8")


def run_cli(workspace: Path, *args, env=None):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True, env=env or env_without_gemini())


def call_api(workspace: Path, path: str, env=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, env=env or env_without_gemini())


def run_ptt(workspace: Path, *args, env=None):
    return subprocess.run([sys.executable, str(PTT), "--workspace", str(workspace), *args], text=True, capture_output=True, env=env or env_without_gemini())


def test_agentos_env_parser_loads_dotenv_without_overriding_existing_env(tmp_path, monkeypatch):
    dotenv = tmp_path / ".env"
    dotenv.write_text("""
# comments and blank lines are ignored
export GEMINI_API_KEY='dotenv-key'
GOOGLE_API_KEY="fallback-key"
EMPTY_VALUE=
PLACEHOLDER_VALUE=<your_key>
BAD-NAME=ignored
""".strip() + "\n", encoding="utf-8")
    monkeypatch.setenv("GOOGLE_API_KEY", "existing-env-wins")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("EMPTY_VALUE", raising=False)
    sys.path.insert(0, str(ROOT))
    from agentos_env import load_workspace_dotenv

    result = load_workspace_dotenv(tmp_path)

    assert result["exists"] is True
    assert result["loaded_keys"] == ["GEMINI_API_KEY"]
    assert os.environ["GEMINI_API_KEY"] == "dotenv-key"
    assert os.environ["GOOGLE_API_KEY"] == "existing-env-wins"
    assert "EMPTY_VALUE" not in os.environ
    assert "PLACEHOLDER_VALUE" not in os.environ


def test_agentosctl_voice_status_loads_gemini_key_from_workspace_dotenv(tmp_path):
    write_voice_config(tmp_path)
    (tmp_path / ".env").write_text("GEMINI_API_KEY=dotenv-test-key\n", encoding="utf-8")

    result = run_cli(tmp_path, "voice", "status", "--pretty")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    gemini = next(provider for provider in data["providers"] if provider["provider"] == "gemini_live")
    assert gemini["ready"] is True
    assert gemini["has_env_key"] is True
    assert gemini["has_inline_key"] is False
    assert "dotenv-test-key" not in result.stdout


def test_dashboard_runtime_diagnostics_loads_gemini_key_from_workspace_dotenv(tmp_path):
    write_voice_config(tmp_path)
    (tmp_path / ".env").write_text("GEMINI_API_KEY=dotenv-dashboard-key\n", encoding="utf-8")

    result = call_api(tmp_path, "/api/dashboard/runtime-diagnostics")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    gemini = data["credential_visibility"]["gemini_live"]
    assert gemini["ready"] is True
    assert gemini["has_env_key"] is True
    assert gemini["has_inline_key"] is False
    assert data["safety"]["secrets_redacted"] is True
    assert "dotenv-dashboard-key" not in result.stdout


def test_push_to_talk_status_loads_gemini_key_from_workspace_dotenv(tmp_path):
    write_voice_config(tmp_path)
    (tmp_path / ".env").write_text("GEMINI_API_KEY=dotenv-ptt-key\n", encoding="utf-8")

    result = run_ptt(tmp_path, "--provider", "gemini_live", "--status")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["ready"] is True
    assert data["has_key"] is True
    assert "dotenv-ptt-key" not in result.stdout


def test_repo_contains_safe_dotenv_template_and_gitignore():
    dotenv = ROOT / ".env"
    example = ROOT / ".env.example"
    gitignore = ROOT / ".gitignore"

    assert dotenv.exists()
    assert example.exists()
    assert gitignore.exists()
    sys.path.insert(0, str(ROOT))
    from agentos_env import parse_dotenv

    dotenv_keys = set(parse_dotenv(dotenv).keys())
    example_text = example.read_text(encoding="utf-8")
    gitignore_text = gitignore.read_text(encoding="utf-8")
    assert {"GEMINI_API_KEY", "GOOGLE_API_KEY"} & dotenv_keys or "GEMINI_API_KEY=" in example_text
    assert "GEMINI_API_KEY=" in example_text
    assert "GOOGLE_API_KEY=" in example_text
    assert ".env" in gitignore_text
    assert "AIza" not in example_text
    assert "dotenv-test-key" not in example_text
