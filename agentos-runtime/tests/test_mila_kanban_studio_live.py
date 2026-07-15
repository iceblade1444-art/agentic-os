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


def test_kanban_studio_endpoint_is_live_read_only_lanes():
    data = call_api("/api/mila/kanban-studio")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_kanban_studio_live_lanes"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["counts"]["queue_items"] >= 0
    assert data["counts"]["queue_runs"] >= 0
    lane_ids = [lane["id"] for lane in data["lanes"]]
    assert lane_ids == ["planned", "building", "judge", "done"]
    for lane in data["lanes"]:
        assert "title" in lane
        assert "count" in lane
        assert "cards" in lane
        assert len(lane["cards"]) <= 8
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob


def test_kanban_studio_frontend_loads_live_lanes():
    text = INDEX.read_text(encoding="utf-8")

    required = [
        "milaKanbanStudioLive",
        "milaKanbanStudioSummary",
        "loadMilaKanbanStudio",
        "renderMilaKanbanStudio",
        "/api/mila/kanban-studio",
        "data-kanban-lane-id",
        "Refresh Kanban studio",
        "live tasks and queue",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_live_kanban_studio():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_kanban_studio_live"] is True
    assert data["checks"]["mila_app_builder_functional"] is True


def test_readme_mentions_phase_5_kanban_studio():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila live Kanban Studio" in text
    assert "/api/mila/kanban-studio" in text
    assert "Planned → Building → Judge → Done" in text
