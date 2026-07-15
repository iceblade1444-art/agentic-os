import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def write_previews(workspace: Path, previews):
    path = workspace / "logs" / "agent-worker" / "runtime-previews.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(previews, ensure_ascii=False, indent=2), encoding="utf-8")


def load_previews(workspace: Path):
    path = workspace / "logs" / "agent-worker" / "runtime-previews.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def preview(preview_id: str, token_status: str, execution_status=None, expires_at="2099-01-01T00:00:00"):
    execution_status = execution_status or ("pending_confirmation" if token_status == "pending" else token_status)
    return {
        "id": preview_id,
        "preview_id": preview_id,
        "one_shot_run_id": f"run_{preview_id}",
        "status": "runtime_execute_preview",
        "execution_status": execution_status,
        "token_status": token_status,
        "expires_at": expires_at,
        "created_at": "2026-01-01T00:00:00",
        "planned": 1,
        "executed": 0,
        "queue_ids": [f"queue_{preview_id}"],
        "confirmation": {"required": True, "accepted": False, "token": f"token_{preview_id}"},
    }


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
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def seed_lifecycle_previews(workspace: Path):
    write_previews(workspace, [
        preview("pending_future", "pending", expires_at="2099-01-01T00:00:00"),
        preview("pending_past", "pending", expires_at="2000-01-01T00:00:00"),
        preview("consumed_item", "consumed", execution_status="runtime_execute_completed"),
        preview("revoked_item", "revoked"),
    ])


def test_cli_runtime_previews_can_filter_by_token_status(tmp_path):
    seed_lifecycle_previews(tmp_path)

    data = cli_json(tmp_path, "agent", "worker", "runtime-previews", "--status", "pending", "--limit", "0", "--pretty")

    assert data["filters"]["status"] == "pending"
    assert data["total"] == 4
    assert data["matched"] == 2
    assert data["count"] == 2
    assert {item["preview_id"] for item in data["previews"]} == {"pending_future", "pending_past"}
    assert all(item["token_status"] == "pending" for item in data["previews"])


def test_api_runtime_previews_can_filter_by_status_query(tmp_path):
    seed_lifecycle_previews(tmp_path)

    data = call_api(tmp_path, "/api/agent-worker/runtime-previews?status=revoked&limit=0")

    assert data["filters"]["status"] == "revoked"
    assert data["matched"] == 1
    assert [item["preview_id"] for item in data["previews"]] == ["revoked_item"]


def test_cli_runtime_preview_expire_stale_marks_only_pending_expired_items(tmp_path):
    seed_lifecycle_previews(tmp_path)

    result = cli_json(tmp_path, "agent", "worker", "runtime-preview-expire-stale", "--pretty")

    assert result["status"] == "runtime_previews_expired"
    assert result["scanned"] == 4
    assert result["expired"] == 1
    assert result["expired_preview_ids"] == ["pending_past"]
    stored = {item["preview_id"]: item for item in load_previews(tmp_path)}
    assert stored["pending_past"]["token_status"] == "expired"
    assert stored["pending_past"]["execution_status"] == "expired"
    assert stored["pending_past"]["expired_at"]
    assert stored["pending_past"]["confirmation"]["reason"] == "token_expired"
    assert stored["pending_future"]["token_status"] == "pending"
    assert stored["consumed_item"]["token_status"] == "consumed"
    assert stored["revoked_item"]["token_status"] == "revoked"

    expired = cli_json(tmp_path, "agent", "worker", "runtime-previews", "--status", "expired", "--limit", "0")
    assert [item["preview_id"] for item in expired["previews"]] == ["pending_past"]


def test_api_runtime_preview_expire_stale_and_filter(tmp_path):
    seed_lifecycle_previews(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-preview/expire-stale", method="POST", payload={})
    filtered = call_api(tmp_path, "/api/agent-worker/runtime-previews?status=expired&limit=0")

    assert result["status"] == "runtime_previews_expired"
    assert result["expired"] == 1
    assert filtered["matched"] == 1
    assert filtered["previews"][0]["preview_id"] == "pending_past"
    assert filtered["previews"][0]["token_status"] == "expired"


def test_dashboard_contains_preview_lifecycle_filter_and_cleanup_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "runtime-preview-expire-stale" in text
    assert "loadAgentWorkerRuntimePreviews('pending')" in text
    assert "loadAgentWorkerRuntimePreviews('consumed')" in text
    assert "loadAgentWorkerRuntimePreviews('expired')" in text
    assert "loadAgentWorkerRuntimePreviews('revoked')" in text
    assert "previewLifecycleFilter" in text
