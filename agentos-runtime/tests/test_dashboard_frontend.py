from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def test_dashboard_frontend_contains_required_panels():
    text = INDEX.read_text(encoding="utf-8")

    assert "AgentOS Mission Control" in text
    assert "System Status" in text
    assert "Projects" in text
    assert "Approvals" in text
    assert "fetch('/api/status')" in text
    assert "fetch('/api/projects')" in text
    assert "fetch('/api/approvals')" in text
    assert "id=\"goalForm\"" in text
    assert "id=\"approvalForm\"" in text
    assert "postJson('/api/goals'" in text
    assert "postJson('/api/approvals/request'" in text
    assert "approveApproval" in text
    assert "denyApproval" in text
    assert "loadTasks" in text
    assert "id=\"tasks\"" in text
    assert "setTaskStatus" in text
    assert "blockTask" in text
    assert "in_progress" in text
    assert "Event Log" in text
    assert "id=\"events\"" in text
    assert "fetch('/api/events')" in text
    assert "Daily Digest" in text
    assert "id=\"digest\"" in text
    assert "fetch('/api/digest')" in text
    assert "Export to Kanban" in text
    assert "exportKanban" in text
    assert "fetch('/api/profiles')" in text
    assert "id=\"profiles\"" in text
    assert "Profile Mapping" in text
    assert "id=\"profileMappingForm\"" in text
    assert "saveProfileMapping" in text
    assert "createRealKanbanTasks" in text
    assert "kanban-create" in text
    assert "Linked Hermes Tasks" in text
    assert "id=\"kanbanLinks\"" in text
    assert "loadKanbanLinks" in text
    assert "Command Bridge" in text
    assert "id=\"commandForm\"" in text
    assert "postJson('/api/command'" in text
    assert "Voice Adapter" in text
    assert "voice_command.py" in text
    assert "Gemini Live" in text
    assert "push_to_talk.py" in text
    assert "fetch('/api/voice-config')" in text
    assert "--status" in text
    assert "voice.local.example.json" in text
    assert "Voice Provider Editor" in text
    assert "toggleVoiceProvider" in text
    assert "voice-config/providers" in text
