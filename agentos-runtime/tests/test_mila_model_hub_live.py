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


def test_model_hub_endpoint_is_live_secret_safe_provider_catalog():
    data = call_api("/api/mila/model-hub")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_model_hub_live_provider_catalog"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["credential_visibility"]["raw_keys_exposed"] is False
    assert data["counts"]["providers"] >= 4
    provider_ids = {provider["id"] for provider in data["providers"]}
    assert {"mock_text", "local_file", "gemini_live", "openai_gpt"}.issubset(provider_ids)
    for provider in data["providers"]:
        assert "enabled" in provider
        assert "ready" in provider
        assert "mode" in provider
        assert "model" in provider
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob
    assert "api_key" not in blob.lower()


def test_model_hub_frontend_loads_live_provider_cards():
    text = INDEX.read_text(encoding="utf-8")

    required = [
        "milaModelHubLive",
        "milaModelHubSummary",
        "loadMilaModelHub",
        "renderMilaModelHub",
        "/api/mila/model-hub",
        "data-model-provider-id",
        "Refresh Model Hub",
        "live provider catalog",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_live_model_hub():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_model_hub_live"] is True
    assert data["checks"]["mila_kanban_studio_live"] is True


def test_readme_mentions_phase_6_model_hub():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila live Model Hub" in text
    assert "/api/mila/model-hub" in text
    assert "raw keys are never returned" in text
