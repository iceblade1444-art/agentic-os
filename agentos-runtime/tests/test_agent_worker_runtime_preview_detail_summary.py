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


def preview(preview_id: str, token_status: str, execution_status=None, expires_at="2099-01-01T00:00:00"):
    execution_status = execution_status or ("pending_confirmation" if token_status == "pending" else token_status)
    return {
        "id": preview_id,
        "preview_id": preview_id,
        "one_shot_run_id": f"runtime_once_{preview_id}",
        "status": "runtime_execute_preview",
        "execution_status": execution_status,
        "token_status": token_status,
        "expires_at": expires_at,
        "created_at": "2026-01-01T00:00:00",
        "worker": "coding-agent",
        "approval_id": "approval_123",
        "planned": 1,
        "executed": 0,
        "queue_ids": [f"queue_{preview_id}"],
        "confirmation": {"required": True, "accepted": False, "token": f"token_{preview_id}"},
    }


def seed_previews(workspace: Path):
    write_previews(workspace, [
        preview("pending_alpha", "pending"),
        preview("pending_beta", "pending"),
        preview("consumed_gamma", "consumed", execution_status="runtime_execute_completed"),
        preview("expired_delta", "expired"),
        preview("revoked_epsilon", "revoked"),
    ])


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


def test_cli_runtime_preview_detail_lookup_by_preview_id(tmp_path):
    seed_previews(tmp_path)

    detail = cli_json(tmp_path, "agent", "worker", "runtime-preview-detail", "--preview-id", "pending_alpha", "--pretty")

    assert detail["status"] == "runtime_preview_found"
    assert detail["preview_id"] == "pending_alpha"
    assert detail["token_status"] == "pending"
    assert detail["preview"]["confirmation"]["token"] == "token_pending_alpha"
    assert detail["preview"]["queue_ids"] == ["queue_pending_alpha"]


def test_api_runtime_preview_detail_lookup_by_preview_id(tmp_path):
    seed_previews(tmp_path)

    detail = call_api(tmp_path, "/api/agent-worker/runtime-previews/pending_beta")

    assert detail["status"] == "runtime_preview_found"
    assert detail["preview_id"] == "pending_beta"
    assert detail["token_status"] == "pending"
    assert detail["preview"]["confirmation"]["token"] == "token_pending_beta"


def test_runtime_previews_response_includes_lifecycle_summary_counts(tmp_path):
    seed_previews(tmp_path)

    data = cli_json(tmp_path, "agent", "worker", "runtime-previews", "--limit", "2", "--pretty")

    assert data["count"] == 2
    assert data["total"] == 5
    assert data["matched"] == 5
    assert data["summary"] == {
        "total": 5,
        "pending": 2,
        "consumed": 1,
        "expired": 1,
        "revoked": 1,
        "not_required": 0,
        "unknown": 0,
    }


def test_runtime_preview_detail_not_found_is_explicit(tmp_path):
    seed_previews(tmp_path)

    detail = cli_json(tmp_path, "agent", "worker", "runtime-preview-detail", "--preview-id", "missing_preview", "--pretty")

    assert detail["status"] == "runtime_preview_not_found"
    assert detail["error"] == "runtime_preview_not_found"
    assert detail["preview_id"] == "missing_preview"
    assert detail["preview"] is None


def test_dashboard_contains_runtime_preview_detail_summary_and_token_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimePreviewDetail" in text
    assert "useAgentWorkerRuntimePreviewToken" in text
    assert "copyAgentWorkerRuntimePreviewToken" in text
    assert "runtime-preview-detail" in text
    assert "summary.pending" in text
    assert "Use token" in text
    assert "Copy token" in text
