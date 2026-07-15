import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(tmp_path)!r}, {path!r}, method={method!r}, payload={repr(payload)}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_profile_mapping_get_and_put(tmp_path):
    get1 = call_api(tmp_path, "/api/profile-mapping")
    assert get1.returncode == 0, get1.stderr
    data1 = json.loads(get1.stdout)
    assert data1["mapping"]["orchestrator"] == "default"

    put = call_api(tmp_path, "/api/profile-mapping", method="POST", payload={"mapping": {"coding-agent": "default", "qa-agent": "reviewer"}})
    assert put.returncode == 0, put.stderr
    data2 = json.loads(put.stdout)
    assert data2["status"] == "saved"
    assert data2["mapping"]["coding-agent"] == "default"
    assert data2["mapping"]["qa-agent"] == "reviewer"

    get2 = call_api(tmp_path, "/api/profile-mapping")
    data3 = json.loads(get2.stdout)
    assert data3["mapping"]["qa-agent"] == "reviewer"


def test_real_kanban_create_dry_run_requires_approval_for_execute(tmp_path):
    created = call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Safe real kanban creation"})
    slug = json.loads(created.stdout)["slug"]
    call_api(tmp_path, "/api/profile-mapping", method="POST", payload={"mapping": {"orchestrator": "default", "content-agent": "default", "coding-agent": "default", "qa-agent": "default"}})

    dry = call_api(tmp_path, f"/api/projects/{slug}/kanban-create", method="POST", payload={"mode": "dry-run"})
    dry_data = json.loads(dry.stdout)
    assert dry_data["mode"] == "dry-run"
    assert dry_data["would_create"] == 4
    assert all("hermes kanban create" in cmd for cmd in dry_data["commands"])

    blocked = call_api(tmp_path, f"/api/projects/{slug}/kanban-create", method="POST", payload={"mode": "execute"})
    blocked_data = json.loads(blocked.stdout)
    assert blocked_data["decision"] == "approval_required"
    assert blocked_data["risk"] == "high"
