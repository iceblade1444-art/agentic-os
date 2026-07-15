import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    cmd = [sys.executable, str(CLI), "--workspace", str(tmp_path), *args]
    return subprocess.run(cmd, text=True, capture_output=True)


def test_init_creates_workspace_structure(tmp_path):
    result = run_cli(tmp_path, "init")

    assert result.returncode == 0, result.stderr
    for name in ["agents", "workflows", "memory", "sops", "projects", "approvals", "logs", "artifacts"]:
        assert (tmp_path / name).is_dir()
    assert (tmp_path / "README.md").exists()


def test_new_goal_creates_project_brief_tasks_and_report(tmp_path):
    run_cli(tmp_path, "init")

    result = run_cli(tmp_path, "new-goal", "Create a landing page for AI SEO agency")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    project_dir = tmp_path / "projects" / data["slug"]
    assert data["status"] == "created"
    assert (project_dir / "project-brief.md").exists()
    assert (project_dir / "tasks.json").exists()
    tasks = json.loads((project_dir / "tasks.json").read_text(encoding="utf-8"))
    assert len(tasks) >= 4
    assert tasks[0]["owner"] == "orchestrator"
    assert all("acceptance_criteria" in task for task in tasks)


def test_list_projects_outputs_created_project(tmp_path):
    run_cli(tmp_path, "init")
    run_cli(tmp_path, "new-goal", "Create a landing page for AI SEO agency")

    result = run_cli(tmp_path, "list-projects")

    assert result.returncode == 0, result.stderr
    projects = json.loads(result.stdout)
    assert len(projects) == 1
    assert projects[0]["slug"] == "create-a-landing-page-for-ai-seo-agency"


def test_approval_lifecycle(tmp_path):
    run_cli(tmp_path, "init")

    created = run_cli(tmp_path, "approval", "create", "send_email", "Send outreach draft", "--risk", "high")
    assert created.returncode == 0, created.stderr
    approval = json.loads(created.stdout)
    assert approval["status"] == "pending"

    approved = run_cli(tmp_path, "approval", "approve", approval["id"])
    assert approved.returncode == 0, approved.stderr
    updated = json.loads(approved.stdout)
    assert updated["status"] == "approved"


def test_report_summarizes_workspace(tmp_path):
    run_cli(tmp_path, "init")
    run_cli(tmp_path, "new-goal", "Create a landing page for AI SEO agency")
    run_cli(tmp_path, "approval", "create", "send_email", "Send outreach draft", "--risk", "high")

    result = run_cli(tmp_path, "report")

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["projects"] == 1
    assert report["pending_approvals"] == 1
    assert report["workspace"].endswith(str(tmp_path))
