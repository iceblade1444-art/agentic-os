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


def create_approved_kanban_approval(tmp_path):
    req = call_api(
        tmp_path,
        "/api/approvals/request",
        method="POST",
        payload={"action": "create_real_kanban_tasks", "summary": "Approve test Kanban execution"},
    )
    approval_id = json.loads(req.stdout)["approval"]["id"]
    call_api(tmp_path, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    return approval_id


def test_approved_simulated_kanban_execution_creates_task_mapping(tmp_path):
    created = call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Approved Kanban mapping"})
    slug = json.loads(created.stdout)["slug"]
    call_api(tmp_path, "/api/profile-mapping", method="POST", payload={"mapping": {"orchestrator": "default", "content-agent": "default", "coding-agent": "default", "qa-agent": "default"}})
    approval_id = create_approved_kanban_approval(tmp_path)

    result = call_api(
        tmp_path,
        f"/api/projects/{slug}/kanban-create",
        method="POST",
        payload={"mode": "execute", "approval_id": approval_id, "simulate": True},
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["mode"] == "execute-simulated"
    assert data["created"] == 4
    mapping_path = Path(data["mapping_path"])
    assert mapping_path.exists()
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    assert mapping["project"] == slug
    assert len(mapping["links"]) == 4
    assert mapping["links"][0]["agentos_task_id"].startswith("T")
    assert mapping["links"][0]["hermes_task_id"].startswith("sim_")


def test_linked_kanban_tasks_api_returns_mapping(tmp_path):
    created = call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Linked tasks API"})
    slug = json.loads(created.stdout)["slug"]
    approval_id = create_approved_kanban_approval(tmp_path)
    call_api(tmp_path, f"/api/projects/{slug}/kanban-create", method="POST", payload={"mode": "execute", "approval_id": approval_id, "simulate": True})

    result = call_api(tmp_path, f"/api/projects/{slug}/kanban-links")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["project"] == slug
    assert len(data["links"]) == 4
