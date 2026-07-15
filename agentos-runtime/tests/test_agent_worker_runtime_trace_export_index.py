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


def write_export(workspace: Path, one_shot_run_id: str, modified_epoch: int):
    path = exports_dir(workspace) / f"{one_shot_run_id}_trace.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# Runtime Trace Export — {one_shot_run_id}\n\n## Safety Metadata\n- Operational ledgers mutated: false\n",
        encoding="utf-8",
    )
    os.utime(path, (modified_epoch, modified_epoch))
    return path


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


def test_api_lists_runtime_trace_exports_newest_first_read_only(tmp_path):
    seed_ledgers(tmp_path)
    old = write_export(tmp_path, "runtime_old", 1_700_000_000)
    middle = write_export(tmp_path, "runtime_middle", 1_700_000_200)
    newest = write_export(tmp_path, "runtime_newest", 1_700_000_400)
    ignored = exports_dir(tmp_path) / "runtime_ignore.txt"
    ignored.write_text("not a trace export", encoding="utf-8")
    before_ledgers = ledger_snapshot(tmp_path)
    before_files = {path.name: path.read_text(encoding="utf-8") for path in [old, middle, newest, ignored]}

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports?limit=2")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_index"
    assert result["total"] == 3
    assert result["count"] == 2
    assert result["limit"] == 2
    assert result["path"] == str(exports_dir(tmp_path))
    assert [item["one_shot_run_id"] for item in result["exports"]] == ["runtime_newest", "runtime_middle"]
    assert [item["filename"] for item in result["exports"]] == ["runtime_newest_trace.md", "runtime_middle_trace.md"]
    assert result["exports"][0]["artifact_path"] == str(newest)
    assert result["exports"][0]["artifact_relpath"] == "artifacts/agent-worker/runtime-traces/runtime_newest_trace.md"
    assert result["exports"][0]["size_bytes"] > 0
    assert result["exports"][0]["modified_at"].startswith("2023-")
    assert result["exports"][0]["title"] == "Runtime Trace Export — runtime_newest"
    assert result["links"]["exports_dir"] == "artifacts/agent-worker/runtime-traces"

    assert ledger_snapshot(tmp_path) == before_ledgers
    assert {path.name: path.read_text(encoding="utf-8") for path in [old, middle, newest, ignored]} == before_files


def test_api_trace_export_index_limit_zero_lists_all_and_empty_dir_is_safe(tmp_path):
    seed_ledgers(tmp_path)
    write_export(tmp_path, "runtime_a", 1_700_000_000)
    write_export(tmp_path, "runtime_b", 1_700_000_100)
    before_ledgers = ledger_snapshot(tmp_path)

    result = call_api(tmp_path, "/api/agent-worker/runtime-trace-exports?limit=0")

    assert result["status"] == "ok"
    assert result["decision"] == "runtime_trace_export_index"
    assert result["total"] == 2
    assert result["count"] == 2
    assert [item["one_shot_run_id"] for item in result["exports"]] == ["runtime_b", "runtime_a"]
    assert ledger_snapshot(tmp_path) == before_ledgers

    empty = tmp_path / "empty-workspace"
    empty_result = call_api(empty, "/api/agent-worker/runtime-trace-exports?limit=10")
    assert empty_result["status"] == "ok"
    assert empty_result["decision"] == "runtime_trace_export_index"
    assert empty_result["total"] == 0
    assert empty_result["count"] == 0
    assert empty_result["exports"] == []
    assert not exports_dir(empty).exists()


def test_dashboard_contains_runtime_trace_exports_panel_and_loader():
    text = INDEX.read_text(encoding="utf-8")
    assert "Runtime Trace Exports" in text
    assert "agentWorkerRuntimeTraceExports" in text
    assert "loadAgentWorkerRuntimeTraceExports" in text
    assert "/api/agent-worker/runtime-trace-exports?limit=10" in text
    assert "runtime_trace_export_index" in text
    assert "loadAgentWorkerRuntimeTraceExports()" in text
    assert "agentWorkerRuntimeTraceExports" in text.split("refreshAll()", 1)[1]
