import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def call_api(path: str):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(ROOT)!r}, {path!r}, method='GET', payload={{}}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, cwd=str(ROOT))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def post_api(path: str, payload: dict):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(ROOT)!r}, {path!r}, method='POST', payload={payload!r}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, cwd=str(ROOT))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_mila_single_agent_status_is_secret_safe():
    data = call_api("/api/mila/status")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_single_agent_status"
    assert data["agent"]["id"] == "mila"
    assert data["agent"]["is_only_visible_agent"] is True
    assert data["voice"]["provider"] == "gemini_live"
    assert data["voice"]["speech_to_speech"] is True
    assert data["models"]["openai_gpt"]["api_key_env"] == "OPENAI_API_KEY"
    assert data["models"]["openai_gpt"]["raw_key_exposed"] is False
    assert data["memory"]["all_present"] is True
    assert data["registry"]["mode"] == "single_agent"

    blob = json.dumps(data, ensure_ascii=False)
    assert "sk-" not in blob
    assert "GEMINI_API_KEY=" not in blob


def test_frontend_has_only_mila_agent_card_source():
    text = INDEX.read_text(encoding="utf-8")

    assert "{id:'mila'" in text
    assert "{id:'claude'" not in text
    assert "{id:'openclaw'" not in text
    assert "gemini_live" in text


def test_mila_nova_voice_agent_status_is_secret_safe():
    data = call_api("/api/mila/voice-agent")

    assert data["status"] == "ok"
    assert data["decision"] == "mila_nova_voice_agent"
    assert data["agent"]["id"] == "mila"
    assert data["runtime"]["primary_provider"] == "gemini_live"
    assert data["runtime"]["target_transport"] == "gemini_native_audio_websocket"
    assert data["runtime"]["websocket_path"] == "/ws/mila/voice"
    assert data["runtime"]["browser_fallback_ready"] is True
    assert data["runtime"]["raw_keys_exposed"] is False
    assert data["reference"]["backend_reference_found"] is True
    assert data["reference"]["frontend_reference_found"] is True
    assert "memory_writeback" in data["turn_loop"]

    blob = json.dumps(data, ensure_ascii=False)
    assert "sk-" not in blob
    assert "GEMINI_API_KEY=" not in blob
    assert "LIVEKIT_API_SECRET=" not in blob


def test_frontend_has_nova_style_mila_voice_ui():
    text = INDEX.read_text(encoding="utf-8")

    assert "Mila NOVA Voice" in text
    assert "/api/mila/voice-agent" in text
    assert "novaSetState" in text
    assert "novaSpeak" in text
    assert "nova-state-listening" in text


def test_mila_visible_tabs_are_live_chat_and_workspace_only():
    text = INDEX.read_text(encoding="utf-8")

    assert "tabs:['chat','workspace']" in text
    assert "▭ Live-Chat" in text
    assert "apiPost('/api/mila/live-chat'" in text
    assert "nova-chat-surface" in text
    assert "nova-agent-core" in text
    assert "chatStartMic" in text
    assert "/ws/mila/voice" in text
    assert "MilaNativeVoiceClient" in text
    assert "floatTo16BitPCM" in text
    assert "pcm16ToFloat32" in text
    assert "Что решаем сегодня?" in text
    assert "Напишите сообщение…" in text
    assert "data-prompt=\"Составь план работы AgentOS на сегодня\"" in text
    assert "nova-composer-dock" in text
    assert "tabs:['chat','talk','jarvis','workspace','studio']" not in text


def test_mila_live_chat_executes_explicit_commands():
    data = post_api("/api/mila/live-chat", {"provider": "gemini_live", "text": "покажи digest"})

    assert data["status"] == "passed"
    assert data["mode"] == "live_chat_command"
    assert data["command"]["intent"] == "show_digest"
    assert "Дайджест" in data["reply"]
    blob = json.dumps(data, ensure_ascii=False)
    assert "sk-" not in blob
    assert "GEMINI_API_KEY=" not in blob
