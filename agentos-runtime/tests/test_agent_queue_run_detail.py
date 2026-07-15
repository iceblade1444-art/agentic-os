import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def runs_path(workspace: Path):
    return workspace / "logs" / "agent-queue" / "runs.json"


def audits_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def queue_run(run_id: str):
    return {
        "run_id": run_id,
        "queue_id": f"queue_{run_id}",
        "project": "project_alpha",
        "task_id": "T001",
        "objective": "Verify queue run detail lookup",
        "owner": "dashboard-agent",
        "worker": "dashboard-agent",
        "executor": "dashboard-agent",
        "trigger": "runtime_confirm_execute",
        "status": "done",
        "started_at": "2026-01-01T00:00:00",
        "completed_at": "2026-01-01T00:00:01",
        "artifact_path": f"C:/tmp/{run_id}.md",
        "log_path": f"C:/tmp/{run_id}.log",
        "result_summary": f"summary for {run_id}",
        "filters": {"project": "project_alpha"},
        "execution_context": {
            "runtime_preview_id": f"preview_{run_id}",
            "one_shot_run_id": f"runtime_once_{run_id}",
            "confirmation_token": f"token_{run_id}",
        },
        "runtime_preview_id": f"preview_{run_id}",
        "one_shot_run_id": f"runtime_once_{run_id}",
        "confirmation_token": f"token_{run_id}",
    }


def runtime_audit(audit_id: str, run_id: str):
    return {
        "id": audit_id,
        "status": "runtime_execute_completed",
        "preview_id": f"preview_{run_id}",
        "one_shot_run_id": f"runtime_once_{run_id}",
        "confirmation_token": f"token_{run_id}",
        "queue_ids": [f"queue_{run_id}"],
        "queue_run_ids": [run_id],
        "executed": 1,
    }


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


def test_api_returns_queue_run_detail_with_trace_links_read_only(tmp_path):
    write_json(runs_path(tmp_path), [queue_run("run_alpha"), queue_run("run_beta")])
    write_json(audits_path(tmp_path), [runtime_audit("audit_alpha", "run_alpha")])
    before_runs = load_json(runs_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-queue/runs/run_alpha")

    assert result["status"] == "agent_queue_run_found"
    assert result["decision"] == "agent_queue_run_detail"
    assert result["run_id"] == "run_alpha"
    assert result["queue_id"] == "queue_run_alpha"
    assert result["project"] == "project_alpha"
    assert result["task_id"] == "T001"
    assert result["runtime_preview_id"] == "preview_run_alpha"
    assert result["one_shot_run_id"] == "runtime_once_run_alpha"
    assert result["confirmation_token"] == "token_run_alpha"
    assert result["run"]["run_id"] == "run_alpha"
    assert result["links"] == {
        "runtime_preview_detail": "/api/agent-worker/runtime-previews/preview_run_alpha",
        "runtime_audit_detail": "/api/agent-worker/runtime-audits/audit_alpha",
        "artifact_path": "C:/tmp/run_alpha.md",
        "log_path": "C:/tmp/run_alpha.log",
    }
    assert load_json(runs_path(tmp_path)) == before_runs
    assert load_json(audits_path(tmp_path)) == before_audits


def test_api_returns_queue_run_not_found_read_only(tmp_path):
    write_json(runs_path(tmp_path), [queue_run("run_alpha")])
    before = load_json(runs_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-queue/runs/missing_run")

    assert result["status"] == "agent_queue_run_not_found"
    assert result["decision"] == "agent_queue_run_detail"
    assert result["run_id"] == "missing_run"
    assert result["run"] is None
    assert result["links"] == {}
    assert load_json(runs_path(tmp_path)) == before


def test_runtime_audit_detail_links_to_queue_run_detail(tmp_path):
    write_json(runs_path(tmp_path), [queue_run("run_alpha")])
    write_json(audits_path(tmp_path), [runtime_audit("audit_alpha", "run_alpha")])
    before_runs = load_json(runs_path(tmp_path))
    before_audits = load_json(audits_path(tmp_path))

    result = call_api(tmp_path, "/api/agent-worker/runtime-audits/audit_alpha")

    assert result["status"] == "runtime_audit_found"
    assert result["links"]["queue_run_details"] == ["/api/agent-queue/runs/run_alpha"]
    assert result["queue_run_ids"] == ["run_alpha"]
    assert load_json(runs_path(tmp_path)) == before_runs
    assert load_json(audits_path(tmp_path)) == before_audits


def test_queue_run_detail_does_not_break_queue_run_listing(tmp_path):
    write_json(runs_path(tmp_path), [queue_run("run_alpha"), queue_run("run_beta")])

    detail = call_api(tmp_path, "/api/agent-queue/runs/run_beta")
    listing = call_api(tmp_path, "/api/agent-queue/runs?limit=0")

    assert detail["status"] == "agent_queue_run_found"
    assert listing["status"] == "ok"
    assert listing["count"] == 2
    assert [item["run_id"] for item in listing["runs"]] == ["run_beta", "run_alpha"]


def test_dashboard_contains_queue_run_detail_action():
    text = INDEX.read_text(encoding="utf-8")
    assert "showAgentQueueRunDetail" in text
    assert "/api/agent-queue/runs/${encodeURIComponent(runId)}" in text
    assert "Queue run detail" in text
    assert "showAgentQueueRunDetail(${JSON.stringify(run.run_id || '')})" in text
