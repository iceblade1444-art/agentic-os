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
            "objective": f"Audit runtime task {index}",
            "owner": owner,
            "status": "planned",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Dry-run audit only"],
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


def approve_cli_worker(workspace: Path, slug: str, owner: str = "coding-agent"):
    cli_json(workspace, "agent", "worker", "configure", "--worker", owner, "--project", slug, "--owner", owner, "--max-items-per-tick", "2")
    request = cli_json(workspace, "agent", "worker", "request-enable", "--summary", f"Enable runtime audit for {slug}")
    approval_id = request["approval"]["id"]
    cli_json(workspace, "approval", "approve", approval_id)
    enable = cli_json(workspace, "agent", "worker", "enable", "--approval-id", approval_id)
    assert enable["status"] == "enabled_preview_only"
    return approval_id


def approve_api_worker(workspace: Path, slug: str, owner: str = "qa-agent"):
    api_json(workspace, "/api/agent-worker/config", method="POST", payload={"worker": owner, "max_items_per_tick": 2, "filters": {"project": slug, "owner": owner}})
    request = api_json(workspace, "/api/agent-worker/request-enable", method="POST", payload={"summary": f"Enable runtime audit for {slug}"})
    approval_id = request["approval"]["id"]
    api_json(workspace, f"/api/approvals/{approval_id}/approve", method="POST", payload={})
    enable = api_json(workspace, "/api/agent-worker/enable", method="POST", payload={"approval_id": approval_id})
    assert enable["status"] == "enabled_preview_only"
    return approval_id


def run_history_count(workspace: Path):
    path = workspace / "logs" / "agent-queue" / "runs.json"
    return len(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else 0


def runtime_audit_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def test_cli_runtime_tick_requires_approved_worker_enable_and_writes_no_audit_when_blocked(tmp_path):
    write_project(tmp_path, "runtime-blocked")
    cli_json(tmp_path, "agent", "worker", "configure", "--worker", "coding-agent", "--project", "runtime-blocked", "--owner", "coding-agent", "--max-items-per-tick", "2")

    result = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--pretty")

    assert result["status"] == "approval_required"
    assert result["executed"] == 0
    assert result["will_execute"] is False
    assert result["scheduler"]["enabled"] is False
    assert result["audit"] is None
    assert not runtime_audit_path(tmp_path).exists()


def test_cli_runtime_tick_after_approval_is_dry_run_only_and_audited(tmp_path):
    slug = "runtime-cli"
    write_project(tmp_path, slug, count=3)
    approval_id = approve_cli_worker(tmp_path, slug)
    before_runs = run_history_count(tmp_path)

    result = cli_json(tmp_path, "agent", "worker", "runtime-tick", "--pretty")

    assert result["status"] == "runtime_dry_run_audited"
    assert result["dry_run"] is True
    assert result["planned"] == 2
    assert result["executed"] == 0
    assert result["will_execute"] is False
    assert result["scheduler"]["enabled"] is False
    assert result["approval"]["approved_id"] == approval_id
    assert [item["queue_id"] for item in result["items"]] == [f"{slug}:T001", f"{slug}:T002"]
    assert result["audit"]["trigger"] == "manual_runtime_dry_run"
    assert result["audit"]["status"] == "runtime_dry_run_audited"
    assert result["audit"]["executed"] == 0
    assert result["audit"]["planned"] == 2
    assert runtime_audit_path(tmp_path).exists()
    assert run_history_count(tmp_path) == before_runs
    tasks = json.loads((tmp_path / "projects" / slug / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["planned", "planned", "planned"]

    audits = cli_json(tmp_path, "agent", "worker", "runtime-audits", "--pretty")
    assert audits["count"] == 1
    assert audits["audits"][0]["id"] == result["audit"]["id"]
    assert audits["audits"][0]["approval_id"] == approval_id


def test_api_runtime_tick_after_approval_is_dry_run_only_and_audited(tmp_path):
    slug = "runtime-api"
    write_project(tmp_path, slug, count=2, owner="qa-agent")
    approval_id = approve_api_worker(tmp_path, slug, owner="qa-agent")
    before_runs = run_history_count(tmp_path)

    result = api_json(tmp_path, "/api/agent-worker/runtime-tick", method="POST", payload={})

    assert result["status"] == "runtime_dry_run_audited"
    assert result["dry_run"] is True
    assert result["planned"] == 2
    assert result["executed"] == 0
    assert result["will_execute"] is False
    assert result["approval"]["approved_id"] == approval_id
    assert [item["queue_id"] for item in result["items"]] == [f"{slug}:T001", f"{slug}:T002"]
    assert result["audit"]["trigger"] == "manual_runtime_dry_run"
    assert run_history_count(tmp_path) == before_runs
    tasks = json.loads((tmp_path / "projects" / slug / "tasks.json").read_text(encoding="utf-8"))
    assert [task["status"] for task in tasks] == ["planned", "planned"]

    audits = api_json(tmp_path, "/api/agent-worker/runtime-audits?limit=5")
    assert audits["count"] == 1
    assert audits["audits"][0]["id"] == result["audit"]["id"]
    assert audits["audits"][0]["approval_id"] == approval_id


def test_dashboard_contains_runtime_audit_controls_and_api_markers():
    text = INDEX.read_text(encoding="utf-8")
    assert "Manual runtime dry-run" in text
    assert "Agent Worker Runtime Audit" in text
    assert "runAgentWorkerRuntimeTick" in text
    assert "loadAgentWorkerRuntimeAudits" in text
    assert "agentWorkerRuntimeAudits" in text
    assert "/api/agent-worker/runtime-tick" in text
    assert "/api/agent-worker/runtime-audits" in text
