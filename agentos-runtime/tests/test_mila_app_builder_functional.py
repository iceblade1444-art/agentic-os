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


def test_app_builder_blueprint_endpoint_is_safe_dry_run_plan():
    data = call_api("/api/mila/app-builder/blueprint?idea=voice%20crm%20assistant")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_app_builder_blueprint_preview"
    assert data["read_only"] is True
    assert data["dry_run"] is True
    assert data["writes_enabled"] is False
    assert data["requires_approval_for_build"] is True
    assert data["idea"] == "voice crm assistant"
    assert data["slug"] == "voice-crm-assistant"
    assert data["flow"] == ["idea", "plan", "approval", "build", "preview", "iterate"]
    assert len(data["plan"]["steps"]) >= 4
    assert data["preview"]["artifact_relpath"].startswith("artifacts/app-builder/voice-crm-assistant/")
    assert data["approval"]["risk"] in {"medium", "high"}
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob


def test_app_builder_frontend_has_functional_controls_and_preview_render():
    text = INDEX.read_text(encoding="utf-8")

    required = [
        "milaAppBuilderIdea",
        "milaAppBuilderResult",
        "loadMilaAppBuilderBlueprint",
        "renderMilaAppBuilderBlueprint",
        "/api/mila/app-builder/blueprint",
        "Preview app blueprint",
        "requires approval before build",
        "idea → plan → approval → build → preview → iterate",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_functional_app_builder():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_app_builder_functional"] is True
    assert data["checks"]["mila_memory_galaxy_live"] is True


def test_readme_mentions_phase_4_app_builder():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila functional app builder" in text
    assert "/api/mila/app-builder/blueprint" in text
    assert "idea → plan → approval → build → preview → iterate" in text
