import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "dashboard" / "backend"
sys.path.insert(0, str(APP_DIR))

from app import handle_api  # noqa: E402


def test_agentic_workflow_config_is_data_driven():
    data = handle_api(ROOT, "/api/agentic-workflow/config")

    assert data["status"] == "ok"
    assert data["decision"] == "agentic_workflow_config"
    assert data["config_path"] == "workflow/agentic_workflow.json"
    assert data["template_reference"] == "tonbistudio/hermes-multi-agent-workflow"
    assert data["research_lanes"]["classifier_lane"] == "serp_gap_audit"
    assert data["gate"]["single_human_gate"] is True


def test_agentic_workflow_run_writes_persistent_artifacts(tmp_path):
    workspace = tmp_path
    payload = {
        "keyword": "agentic workflow artifact verification",
        "slug": "agentic-workflow-artifact-verification",
        "auto_deploy": False,
    }

    data = handle_api(workspace, "/api/agentic-workflow/run", method="POST", payload=payload)

    assert data["status"] == "ok"
    run = data["run"]
    assert run["workspace"] == "work/seo-pipeline/article-packs/agentic-workflow-artifact-verification"
    assert run["safety"]["dry_run"] is True
    assert run["safety"]["external_publish"] is False
    assert run["artifacts"]["manifest"].endswith("manifest.json")

    for artifact in [
        run["artifacts"]["intake"],
        run["artifacts"]["dedup_score"],
        run["artifacts"]["proposal"],
        run["artifacts"]["delivery_plan"],
        run["artifacts"]["manifest"],
        *run["artifacts"]["research_lanes"],
    ]:
        assert (workspace / artifact).exists(), artifact

    manifest = json.loads((workspace / run["artifacts"]["manifest"]).read_text(encoding="utf-8"))
    assert manifest["run_id"] == run["id"]
    assert manifest["path"] == "article_pack"
    assert manifest["safety"]["single_human_gate"] is True

    stage_artifacts = {stage.get("artifact") for stage in run["stages"] if stage.get("artifact")}
    assert run["artifacts"]["intake"] in stage_artifacts
    assert run["artifacts"]["proposal"] in stage_artifacts
    assert any(path.endswith("research-serp_gap_audit.md") for path in stage_artifacts)


def test_agentic_workflow_gate_approval_continues_fulfillment(tmp_path):
    workspace = tmp_path
    run_data = handle_api(
        workspace,
        "/api/agentic-workflow/run",
        method="POST",
        payload={
            "keyword": "agentic workflow gate continuation",
            "slug": "agentic-workflow-gate-continuation",
            "auto_deploy": True,
        },
    )

    run = run_data["run"]
    approval_id = run["approval"]["id"]
    assert run["approval"]["action"] == "agentic_workflow_gate"
    assert any(stage["status"] == "blocked" for stage in run["stages"])

    approved = handle_api(workspace, f"/api/approvals/{approval_id}/approve", method="POST", payload={})

    assert approved["status"] == "approved"
    workflow_result = approved["workflow_gate_result"]["run"]
    assert workflow_result["status"] == "fulfilled"
    assert workflow_result["approval_id"] == approval_id
    assert workflow_result["artifacts"]["fulfillment"]
    assert workflow_result["artifacts"]["final_delivery_report"].endswith("05-final-delivery-report.md")
    assert workflow_result["queue_project"]["created"] is True
    assert workflow_result["queue_project"]["tasks"] >= 1
    queue_project = workflow_result["queue_project"]["project"]
    assert queue_project.startswith("workflow-agentic-workflow-gate-continuation")
    assert all(stage["status"] != "blocked" for stage in workflow_result["stages"])

    for artifact in [*workflow_result["artifacts"]["fulfillment"], workflow_result["artifacts"]["final_delivery_report"]]:
        assert (workspace / artifact).exists(), artifact

    task_file = workspace / "projects" / queue_project / "tasks.json"
    assert task_file.exists()
    tasks = json.loads(task_file.read_text(encoding="utf-8"))
    assert tasks
    assert tasks[0]["workflow_run_id"] == workflow_result["id"]
    assert tasks[0]["status"] == "planned"
    assert tasks[0]["requires_approval"] is False
    assert tasks[0]["lane"] == "workflow-fulfillment"

    queue = handle_api(workspace, "/api/agent-queue")
    assert any(item["project"] == queue_project and item["task_id"] == "W001" for item in queue["items"])

    executed = handle_api(workspace, "/api/agent-queue/run-next", method="POST", payload={"project": queue_project, "worker": "workflow-test-worker"})
    assert executed["status"] in {"done", "executed", "executed_next"}
    refreshed_tasks = json.loads(task_file.read_text(encoding="utf-8"))
    assert refreshed_tasks[0]["status"] == "done"

    manifest = json.loads((workspace / workflow_result["artifacts"]["manifest"]).read_text(encoding="utf-8"))
    assert manifest["status"] == "fulfilled"
    assert manifest["artifacts"]["final_delivery_report"] == workflow_result["artifacts"]["final_delivery_report"]


def test_agentic_workflow_gate_denial_shelves_run(tmp_path):
    workspace = tmp_path
    run_data = handle_api(
        workspace,
        "/api/agentic-workflow/run",
        method="POST",
        payload={
            "keyword": "agentic workflow gate denial",
            "slug": "agentic-workflow-gate-denial",
            "auto_deploy": True,
        },
    )

    approval_id = run_data["run"]["approval"]["id"]
    denied = handle_api(workspace, f"/api/approvals/{approval_id}/deny", method="POST", payload={})

    assert denied["status"] == "denied"
    workflow_result = denied["workflow_gate_result"]["run"]
    assert workflow_result["status"] == "shelved"
    assert any(stage.get("block_reason") == "operator denied/shelved workflow gate" for stage in workflow_result["stages"])


def test_agentic_workflow_frontend_exposes_artifacts():
    frontend = (ROOT / "dashboard" / "frontend" / "index.html").read_text(encoding="utf-8")

    assert "WORKFLOW ARTIFACTS" in frontend
    assert "artifact=" in frontend
    assert "Workflow artifacts created" in frontend
    assert "final_delivery_report" in frontend
    assert "queue_project" in frontend
