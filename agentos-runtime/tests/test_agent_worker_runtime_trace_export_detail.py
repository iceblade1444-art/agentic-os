import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


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


def exports_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-traces"


def export_path(workspace: Path, one_shot_run_id: str):
    return exports_dir(workspace) / f"{one_shot_run_id}_trace.md"


def previews_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def attempts_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json"


def audits_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def runs_path(workspace: Path):
    return workspace / "logs" / "agent-queue" / "runs.json"


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def seed_ledgers(workspace: Path):
    write_json(previews_path(workspace), [{"preview_id": "preview_keep", "one_shot_run_id": "runtime_keep"}])
    write_json(attempts_path(workspace), [{"id": "attempt_keep", "one_shot_run_id": "runtime_keep"}])
    write_json(audits_path(workspace), [{"id": "audit_keep", "one_shot_run_id": "runtime_keep"}])
    write_json(runs_path(workspace), [{"run_id": "run_keep", "one_shot_run_id": "runtime_keep"}])


def ledger_snapshot(workspace: Path):
    return {
        "previews": load_json(previews_path(workspace)),
        "attempts": load_json(attempts_path(workspace)),
        "audits": load_json(audits_path(workspace)),
        "runs": load_json(runs_path(workspace)),
    }


def write_export(workspace: Path, one_shot_run_id: str, content: str, modified_epoch: int = 1_700_000_500):
    path = export_path(workspace, one_shot_run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (modified_epoch, modified_epoch))
    return path


def test_api_reads_runtime_trace_export_detail_bounded_redacted_and_read_only(tmp_path):
    seed_ledgers(tmp_path)
    one_shot_run_id = "runtime_detail_alpha"
    raw_content = "\n".join([
        "# Runtime Trace Export — runtime_detail_alpha",
        "",
        "## Summary",
        "- Preview ID: preview_alpha",
        "- confirmation_token: token_should_not_leak",
        "",
        "## Safety Metadata",
        "- Operational ledgers mutated: false",
        "- Artifact only write: true",
        "",
        "## Long Body",
        "0123456789" * 30,
    ])
    path = write_export(tmp_path, one_shot_run_id, raw_content)
    before_ledgers = ledger_snapshot(tmp_path)
    before_content = path.read_text(encoding="utf-8")

    result = call_api(tmp_path, f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}?max_chars=180")

    assert result["status"] == "runtime_trace_export_found"
    assert result["decision"] == "runtime_trace_export_detail"
    assert result["one_shot_run_id"] == one_shot_run_id
    assert result["filename"] == "runtime_detail_alpha_trace.md"
    assert result["title"] == "Runtime Trace Export — runtime_detail_alpha"
    assert result["artifact_path"] == str(path)
    assert result["artifact_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_detail_alpha_trace.md"
    assert result["size_bytes"] == path.stat().st_size
    assert result["line_count"] == len(raw_content.splitlines())
    assert result["content_length"] >= len(raw_content) - len("token_should_not_leak")
    assert result["max_chars"] == 180
    assert len(result["content_preview"]) == 180
    assert result["truncated"] is True
    assert "# Runtime Trace Export — runtime_detail_alpha" in result["content_preview"]
    assert "token_should_not_leak" not in result["content_preview"]
    assert "[REDACTED]" in result["content_preview"]
    assert result["redactions"] == ["confirmation_token"]
    assert result["links"] == {
        "export_index": "/api/agent-worker/runtime-trace-exports?limit=20",
        "trace_graph": "/api/agent-worker/runtime-traces/runtime_detail_alpha",
        "regenerate_export": "/api/agent-worker/runtime-traces/runtime_detail_alpha/export",
    }

    assert ledger_snapshot(tmp_path) == before_ledgers
    assert path.read_text(encoding="utf-8") == before_content


def test_api_runtime_trace_export_detail_not_found_and_empty_dir_are_read_only(tmp_path):
    seed_ledgers(tmp_path)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports/runtime_missing?max_chars=100")

    assert result["status"] == "runtime_trace_export_not_found"
    assert result["decision"] == "runtime_trace_export_detail"
    assert result["one_shot_run_id"] == "runtime_missing"
    assert result["artifact_path"] is None
    assert result["artifact_relpath"] is None
    assert result["content_preview"] == ""
    assert result["truncated"] is False
    assert result["links"] == {"export_index": "/api/agent-worker/runtime-trace-exports?limit=20"}
    assert ledger_snapshot(tmp_path) == before_ledgers
    assert not exports_dir(tmp_path).exists()


def test_api_runtime_trace_export_detail_max_chars_zero_returns_full_redacted_content(tmp_path):
    seed_ledgers(tmp_path)
    one_shot_run_id = "runtime_detail_full"
    raw_content = "# Runtime Trace Export — runtime_detail_full\nconfirmation_token=token_full_secret\nbody line"
    write_export(tmp_path, one_shot_run_id, raw_content)

    result = call_api(tmp_path, f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}?max_chars=0")

    assert result["status"] == "runtime_trace_export_found"
    assert result["max_chars"] == 0
    assert result["truncated"] is False
    assert "body line" in result["content_preview"]
    assert "token_full_secret" not in result["content_preview"]
    assert "confirmation_token=[REDACTED]" in result["content_preview"]


def test_dashboard_contains_runtime_trace_export_detail_view_action():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentWorkerRuntimeTraceExportDetail" in text
    assert "/api/agent-worker/runtime-trace-exports/${encodeURIComponent(oneShotRunId)}?max_chars=4000" in text
    assert "Runtime trace export detail" in text
    assert "View export" in text
    assert "showAgentWorkerRuntimeTraceExportDetail(${JSON.stringify(item.one_shot_run_id || '')})" in text
