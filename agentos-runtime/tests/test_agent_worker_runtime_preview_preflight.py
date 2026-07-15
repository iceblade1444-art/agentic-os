import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def previews_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def write_previews(workspace: Path, previews):
    path = previews_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(previews, ensure_ascii=False, indent=2), encoding="utf-8")


def load_previews(workspace: Path):
    return json.loads(previews_path(workspace).read_text(encoding="utf-8"))


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
        "planned": 1,
        "executed": 0,
        "queue_ids": [f"queue_{preview_id}"],
        "confirmation": {"required": True, "accepted": False, "token": f"token_{preview_id}"},
    }


def seed_previews(workspace: Path):
    write_previews(workspace, [
        preview("pending_future", "pending", expires_at="2099-01-01T00:00:00"),
        preview("pending_past", "pending", expires_at="2000-01-01T00:00:00"),
        preview("consumed_item", "consumed", execution_status="runtime_execute_completed"),
        preview("revoked_item", "revoked"),
        preview("expired_item", "expired"),
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


def test_cli_runtime_preview_validate_token_reports_pending_without_execution(tmp_path):
    seed_previews(tmp_path)
    before = load_previews(tmp_path)

    result = cli_json(tmp_path, "agent", "worker", "runtime-preview-validate-token", "--confirmation-token", "token_pending_future", "--pretty")

    assert result["status"] == "confirmation_token_pending"
    assert result["decision"] == "confirmation_preflight"
    assert result["valid"] is True
    assert result["can_execute"] is True
    assert result["will_execute"] is False
    assert result["dry_run"] is True
    assert result["reason"] == "confirmation token is pending and not expired"
    assert result["preview_id"] == "pending_future"
    assert result["token_status"] == "pending"
    assert result["confirmation"]["reason"] == "token_pending"
    assert load_previews(tmp_path) == before


def test_cli_runtime_preview_validate_token_reports_blocked_states_without_mutation(tmp_path):
    seed_previews(tmp_path)
    before = load_previews(tmp_path)

    cases = {
        "token_pending_past": ("confirmation_token_expired", "expired", "token_expired"),
        "token_expired_item": ("confirmation_token_expired", "expired", "token_expired"),
        "token_revoked_item": ("confirmation_token_revoked", "revoked", "token_revoked"),
        "token_consumed_item": ("confirmation_token_consumed", "consumed", "token_consumed"),
        "missing_token": ("confirmation_token_not_found", "unknown", "invalid_confirmation_token"),
    }
    for token, (status, token_status, reason) in cases.items():
        result = cli_json(tmp_path, "agent", "worker", "runtime-preview-validate-token", "--confirmation-token", token, "--pretty")
        assert result["status"] == status
        assert result["decision"] == "confirmation_preflight"
        assert result["valid"] is False
        assert result["can_execute"] is False
        assert result["will_execute"] is False
        assert result["dry_run"] is True
        assert result["token_status"] == token_status
        assert result["confirmation"]["reason"] == reason
    assert load_previews(tmp_path) == before


def test_api_runtime_preview_validate_token_reports_preflight_detail(tmp_path):
    seed_previews(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-preview/validate-token", method="POST", payload={"confirmation_token": "token_revoked_item"})

    assert result["status"] == "confirmation_token_revoked"
    assert result["decision"] == "confirmation_preflight"
    assert result["valid"] is False
    assert result["can_execute"] is False
    assert result["preview_id"] == "revoked_item"
    assert result["token_status"] == "revoked"
    assert result["confirmation"]["reason"] == "token_revoked"
    assert result["preview"]["confirmation"]["token"] == "token_revoked_item"


def test_api_runtime_preview_validate_token_accepts_preview_id_fallback(tmp_path):
    seed_previews(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-preview/validate-token", method="POST", payload={"preview_id": "pending_future"})

    assert result["status"] == "confirmation_token_pending"
    assert result["valid"] is True
    assert result["can_execute"] is True
    assert result["confirmation_token"] == "token_pending_future"
    assert result["preview_id"] == "pending_future"


def test_dashboard_contains_runtime_preview_validate_token_controls():
    text = INDEX.read_text(encoding="utf-8")
    assert "runtime-preview-validate-token" in text
    assert "/api/agent-worker/runtime-preview/validate-token" in text
    assert "validateAgentWorkerRuntimePreviewToken" in text
    assert "Preflight token" in text
    assert "confirmation_preflight" in text
