import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard" / "backend"))

from app import create_agentic_goal, handle_api  # noqa: E402


def make_workspace(tmp_path: Path):
    for relpath, value in [
        ("agents/queue.json", []),
        ("approvals/approvals.json", []),
        ("logs/events.json", []),
        ("logs/agent-queue/runs.json", []),
    ]:
        path = tmp_path / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
    return tmp_path


def test_hermes_mock_plan_becomes_agentos_tasks_and_high_risk_gate(tmp_path, monkeypatch):
    workspace = make_workspace(tmp_path)
    monkeypatch.setenv("AGENTOS_HERMES_MOCK_PLAN", json.dumps({
        "summary": "Research, build, then deploy with approval.",
        "tasks": [
            {
                "id": "T001",
                "title": "Research the current system",
                "owner": "researcher",
                "depends_on": [],
                "risk_level": "low",
                "acceptance_criteria": ["Findings saved"],
                "artifacts": ["research/findings.md"],
                "lane": "research",
            },
            {
                "id": "T002",
                "title": "Deploy the verified release to production",
                "owner": "release-agent",
                "depends_on": ["T001"],
                "risk_level": "high",
                "requires_approval": True,
                "acceptance_criteria": ["Health check passes"],
                "artifacts": ["reports/deploy.md", "../unsafe.txt"],
                "lane": "release",
            },
        ],
    }))

    created = create_agentic_goal(workspace, "Hermes integration test")
    tasks = json.loads((workspace / "projects" / created["slug"] / "tasks.json").read_text(encoding="utf-8"))
    approvals = json.loads((workspace / "approvals" / "approvals.json").read_text(encoding="utf-8"))

    assert created["orchestrator"]["primary"] == "hermes"
    assert created["orchestrator"]["plan_source"] == "hermes_mock"
    assert [task["owner"] for task in tasks] == ["researcher", "approval-guard", "release-agent"]
    assert tasks[1]["requires_approval"] is True
    assert tasks[2]["depends_on"] == [tasks[1]["id"]]
    assert tasks[2]["artifacts"] == ["reports/deploy.md"]
    assert len(approvals) == 1
    assert approvals[0]["context"]["orchestrator"] == "hermes"


def test_hermes_status_endpoint_is_primary_and_secret_safe(tmp_path, monkeypatch):
    workspace = make_workspace(tmp_path)
    monkeypatch.setenv("AGENTOS_HERMES_MOCK_PLAN", '{"summary":"ok","tasks":[{"title":"Test","owner":"tester"}]}')

    data = handle_api(workspace, "/api/orchestrator/status")

    assert data["decision"] == "hermes_primary_orchestrator_status"
    assert data["primary"] is True
    assert data["ready"] is True
    assert data["agent"]["role"] == "primary_orchestrator"
    assert data["secrets_included"] is False
    assert "sk-" not in json.dumps(data)
