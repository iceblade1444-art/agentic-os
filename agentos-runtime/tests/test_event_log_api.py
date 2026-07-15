import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"


def call_api(tmp_path, path, method="GET", payload=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(tmp_path)!r}, {path!r}, method={method!r}, payload={repr(payload)}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    return subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)


def test_event_log_starts_empty(tmp_path):
    result = call_api(tmp_path, "/api/events")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ok"
    assert data["events"] == []
    assert data["pagination"]["total"] == 0


def test_goal_creation_writes_event(tmp_path):
    call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Audit log goal"})

    result = call_api(tmp_path, "/api/events")

    assert result.returncode == 0, result.stderr
    events = json.loads(result.stdout)["events"]
    assert len(events) == 1
    assert events[0]["type"] == "goal_created"
    assert events[0]["actor"] == "dashboard"
    assert events[0]["project"] == "audit-log-goal"


def test_approval_request_and_decision_write_events(tmp_path):
    created = call_api(
        tmp_path,
        "/api/approvals/request",
        method="POST",
        payload={"action": "send_email", "summary": "Send audited email"},
    )
    approval_id = json.loads(created.stdout)["approval"]["id"]
    call_api(tmp_path, f"/api/approvals/{approval_id}/approve", method="POST", payload={})

    events = json.loads(call_api(tmp_path, "/api/events?latest_first=false").stdout)["events"]

    assert [event["type"] for event in events] == ["approval_requested", "approval_approved"]
    assert events[0]["approval_id"] == approval_id
    assert events[1]["approval_id"] == approval_id


def test_task_mutation_writes_events(tmp_path):
    goal = call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Task events"})
    slug = json.loads(goal.stdout)["slug"]
    call_api(tmp_path, f"/api/projects/{slug}/tasks/T002/status", method="POST", payload={"status": "in_progress"})
    call_api(tmp_path, f"/api/projects/{slug}/tasks/T003/block", method="POST", payload={"reason": "Need context"})

    events = json.loads(call_api(tmp_path, "/api/events").stdout)["events"]
    event_types = [event["type"] for event in events]

    assert "task_status_changed" in event_types
    assert "task_blocked" in event_types


def test_event_log_is_paginated_and_bounded(tmp_path):
    for idx in range(5):
        call_api(tmp_path, "/api/goals", method="POST", payload={"goal": f"Event page {idx}"})

    result = call_api(tmp_path, "/api/events?limit=2&offset=1")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ok"
    assert len(data["events"]) == 2
    assert data["pagination"] == {
        "total": 5,
        "limit": 2,
        "offset": 1,
        "returned": 2,
        "latest_first": True,
        "has_more": True,
        "next_offset": 3,
    }


def test_event_log_raw_format_preserves_legacy_array_shape(tmp_path):
    call_api(tmp_path, "/api/goals", method="POST", payload={"goal": "Legacy events"})

    result = call_api(tmp_path, "/api/events?format=raw")

    assert result.returncode == 0, result.stderr
    events = json.loads(result.stdout)
    assert isinstance(events, list)
    assert events[0]["type"] == "goal_created"
