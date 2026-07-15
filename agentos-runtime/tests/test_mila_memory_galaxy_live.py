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


def test_memory_galaxy_endpoint_is_read_only_live_graph():
    data = call_api("/api/mila/memory-galaxy")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_memory_galaxy_live_graph"
    assert data["read_only"] is True
    assert data["writes_enabled"] is False
    assert data["secrets_included"] is False
    assert data["counts"]["reports"] >= 1
    assert data["counts"]["projects"] >= 0
    assert data["latest_report"]["relpath"].startswith("logs/daily/")
    node_ids = {node["id"] for node in data["nodes"]}
    assert {"projects", "reports", "events", "sops", "skills", "voice-transcripts"}.issubset(node_ids)
    for node in data["nodes"]:
        assert "label" in node
        assert "count" in node
        assert "kind" in node
    blob = json.dumps(data, ensure_ascii=False)
    assert "GEMINI_API_KEY" not in blob
    assert "GOOGLE_API_KEY" not in blob


def test_memory_galaxy_frontend_loads_live_endpoint_and_renders_nodes():
    text = INDEX.read_text(encoding="utf-8")

    required = [
        "milaMemoryGalaxyLive",
        "milaMemoryGalaxySummary",
        "loadMilaMemoryGalaxy",
        "renderMilaMemoryGalaxy",
        "/api/mila/memory-galaxy",
        "data-memory-node-id",
        "Refresh memory galaxy",
        "live second brain",
    ]
    for marker in required:
        assert marker in text


def test_release_check_tracks_live_memory_galaxy():
    result = subprocess.run([sys.executable, str(CLI), "--workspace", str(ROOT), "release", "check"], text=True, capture_output=True, cwd=str(ROOT))

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["checks"]["mila_memory_galaxy_live"] is True
    assert data["checks"]["mila_agent_dock_live"] is True


def test_readme_mentions_phase_3_memory_galaxy():
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mila live memory galaxy" in text
    assert "/api/mila/memory-galaxy" in text
    assert "voice-transcripts" in text
