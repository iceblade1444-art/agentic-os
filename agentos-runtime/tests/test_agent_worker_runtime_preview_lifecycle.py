import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_project(workspace: Path, slug: str, count: int = 2, owner: str = "coding-agent"):
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps({"slug": slug, "goal": f"Goal {slug}"}), encoding="utf-8")
    tasks = []
    for index in range(1, count + 1):
        tasks.append({
            "id": f"T{index:03d}",
            "project": slug,
            "objective": f"Runtime preview lifecycle task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Preview token lifecycle guard"],
            "artifacts": [],
            "block_reason": None,
        })
    (project_dir / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")


def run_cli(workspace: Path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(workspace), *args], text=True, capture_output=True)


def cli_json(workspace: Path, *args):
    result = run_cli(workspace, *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def call_api(workspace: Path, path: str, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def api_json(workspace: Path, path: str, method="GET", payload=None):
    result = call_api(workspace, path, method=method, payload=payload)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def approve_cli_worker(workspace: Path):
    request = cli_json(workspace, "agent", "worker", "request-enable", "--summary", "Approve preview lifecycle")
    approval_id = request["approval"]["id"]
    cli_json(workspace, "approval", "approve", approval_id)
    enabled = cli_json(workspace, "agent", "worker", "enable", "--approval-id", approval_id)
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def approve_api_worker(workspace: Path):
    request = api_json(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": "Approve preview lifecycle"})
    approval_id = request["approval"]["id"]
    api_json(workspace, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    enabled = api_json(workspace, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert enabled["status"] == "enabled_preview_only"
    return approval_id


def previews_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def load_previews(workspace: Path):
    path = previews_path(workspace)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def save_previews(workspace: Path, previews):
    previews_path(workspace).write_text(json.dumps(previews, ensure_ascii=False, indent=2), encoding="utf-8")


def load_runs(workspace: Path):
    path = workspace / "logs" / "agent-queue" / "runs.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def load_audits(workspace: Path):
    path = workspace / "logs" / "agent-worker" / "runtime-ticks.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def task_statuses(workspace: Path, slug: str):
    tasks = json.loads((workspace / "projects" / slug / "tasks.json").read_text(encoding="utf-8"))
    return {task["id"]: task["status"] for task in tasks}


def test_cli_runtime_preview_revoke_blocks_token_without_mutation(tmp_path):
    slug = "runtime-preview-revoke-cli"
    write_project(tmp_path, slug, count=1)
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", slug, "--owner", "coding-agent", "--max-items-per-tick", "1", "--runtime-mode", "execute")
    approve_cli_worker(tmp_path)

    preview = cli_json(tmp_path, "agent", "worker", "runtime-preview", "--pretty")
    token = preview["confirmation"]["token"]
    assert preview["token_status"] == "pending"
    assert preview["expires_at"]

    revoked = cli_json(tmp_path, "agent", "worker", "runtime-preview-revoke", "--confirmation-token", token, "--reason", "operator_cancelled", "--pretty")
    assert revoked["status"] == "runtime_preview_revoked"
    assert revoked["token_status"] == "revoked"
    assert revoked["execution_status"] == "revoked"
    assert revoked["preview_id"] == preview["preview_id"]
    assert revoked["confirmation"]["accepted"] is False
    assert revoked["confirmation"]["reason"] == "token_revoked"

    runs_before = len(load_runs(tmp_path))
    audits_before = len(load_audits(tmp_path))
    rejected = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--confirmation-token", token, "--pretty")

    assert rejected["status"] == "confirmation_token_revoked"
    assert rejected["decision"] == "confirmation_rejected"
    assert rejected["reason"] == "confirmation token was revoked before execution"
    assert rejected["executed"] == 0
    assert rejected["preview_id"] == preview["preview_id"]
    assert rejected["confirmation"]["reason"] == "token_revoked"
    assert len(load_runs(tmp_path)) == runs_before
    assert len(load_audits(tmp_path)) == audits_before
    assert task_statuses(tmp_path, slug)["T001"] == "planned"


def test_api_expired_runtime_preview_token_is_rejected_without_mutation(tmp_path):
    slug = "runtime-preview-expired-api"
    write_project(tmp_path, slug, count=1, owner="qa-agent")
    api_json(tmp_path, "/api/agent-worker/config", method="POST", payload={"worker": "qa-agent", "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": "qa-agent"}})
    approve_api_worker(tmp_path)

    preview = api_json(tmp_path, "/api/agent-worker/runtime-preview", method="POST", payload={})
    token = preview["confirmation"]["token"]
    assert preview["token_status"] == "pending"
    assert preview["expires_at"]

    previews = load_previews(tmp_path)
    for item in previews:
        if item["preview_id"] == preview["preview_id"]:
            item["expires_at"] = "2000-01-01T00:00:00"
    save_previews(tmp_path, previews)

    runs_before = len(load_runs(tmp_path))
    audits_before = len(load_audits(tmp_path))
    rejected = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirmation_token": token})

    assert rejected["status"] == "confirmation_token_expired"
    assert rejected["decision"] == "confirmation_rejected"
    assert rejected["reason"] == "confirmation token expired before execution"
    assert rejected["executed"] == 0
    assert rejected["preview_id"] == preview["preview_id"]
    assert rejected["confirmation"]["reason"] == "token_expired"
    assert len(load_runs(tmp_path)) == runs_before
    assert len(load_audits(tmp_path)) == audits_before
    assert task_statuses(tmp_path, slug)["T001"] == "planned"
    stored = next(item for item in load_previews(tmp_path) if item["preview_id"] == preview["preview_id"])
    assert stored["token_status"] == "expired"
    assert stored["execution_status"] == "expired"


def test_api_runtime_preview_revoke_endpoint_blocks_token(tmp_path):
    slug = "runtime-preview-revoke-api"
    write_project(tmp_path, slug, count=1, owner="qa-agent")
    api_json(tmp_path, "/api/agent-worker/config", method="POST", payload={"worker": "qa-agent", "max_items_per_tick": 1, "runtime_mode": "execute", "filters": {"project": slug, "owner": "qa-agent"}})
    approve_api_worker(tmp_path)

    preview = api_json(tmp_path, "/api/agent-worker/runtime-preview", method="POST", payload={})
    revoked = api_json(tmp_path, "/api/agent-worker/runtime-preview/revoke", method="POST", payload={"preview_id": preview["preview_id"], "reason": "operator_cancelled"})
    assert revoked["status"] == "runtime_preview_revoked"
    assert revoked["token_status"] == "revoked"
    assert revoked["preview_id"] == preview["preview_id"]

    rejected = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={"confirmation_token": preview["confirmation"]["token"]})
    assert rejected["status"] == "confirmation_token_revoked"
    assert rejected["executed"] == 0


def test_dashboard_contains_preview_lifecycle_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "runtime-preview-revoke" in text
    assert "confirmation_token_expired" in text
    assert "confirmation_token_revoked" in text
    assert "token_status" in text
    assert "expires_at" in text
