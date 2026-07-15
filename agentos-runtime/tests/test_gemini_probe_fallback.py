import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVIDER = ROOT / "voice" / "providers" / "gemini_live.py"


def load_provider():
    spec = importlib.util.spec_from_file_location("agentos_test_gemini_live", PROVIDER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_probe_once_falls_back_when_first_generate_model_is_retryable(monkeypatch):
    provider = load_provider()
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls = []

    def fake_request_json(url, *, payload=None):
        calls.append(url)
        if url.endswith("/models?key=test-key"):
            return {
                "models": [
                    {"name": "models/gemini-live-3.1", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                ]
            }
        if "models/gemini-live-3.1:generateContent" in url:
            raise RuntimeError("gemini_live HTTP 503: temporary high demand")
        if "models/gemini-2.5-flash:generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": "AGENTOS_GEMINI_OK"}]}}]}
        raise AssertionError(url)

    monkeypatch.setattr(provider, "_request_json", fake_request_json)

    result = provider.probe_once({"enabled": True, "allow_env_credentials": True, "model": "gemini-live-3.1"})

    assert result["status"] == "passed"
    assert result["probe_model"] == "models/gemini-2.5-flash"
    assert result["probe_response"] == "AGENTOS_GEMINI_OK"
    assert result["transport"] == "rest-probe"
    assert any("models/gemini-live-3.1:generateContent" in url for url in calls)
    assert any("models/gemini-2.5-flash:generateContent" in url for url in calls)


def test_normalize_command_text_falls_back_when_first_generate_model_is_retryable(monkeypatch):
    provider = load_provider()
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    def fake_request_json(url, *, payload=None):
        if url.endswith("/models?key=test-key"):
            return {
                "models": [
                    {"name": "models/gemini-live-3.1", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                ]
            }
        if "models/gemini-live-3.1:generateContent" in url:
            raise RuntimeError("gemini_live HTTP 503: temporary high demand")
        if "models/gemini-2.5-flash:generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": '{"command_text":"покажи digest","reason":"digest request"}'}]}}]}
        raise AssertionError(url)

    monkeypatch.setattr(provider, "_request_json", fake_request_json)

    result = provider.normalize_command_text({"enabled": True, "allow_env_credentials": True, "model": "gemini-live-3.1"}, "дай сводку")

    assert result["normalized_text"] == "покажи digest"
    assert result["model"] == "models/gemini-2.5-flash"
    assert result["transport"] == "rest-normalize"


def test_probe_once_skips_audio_only_tts_models_when_falling_back(monkeypatch):
    provider = load_provider()
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls = []

    def fake_request_json(url, *, payload=None):
        calls.append(url)
        if url.endswith("/models?key=test-key"):
            return {
                "models": [
                    {"name": "models/gemini-live-3.1", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/gemini-2.5-flash-preview-tts", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/gemini-exp-text", "supportedGenerationMethods": ["generateContent"]},
                ]
            }
        if "models/gemini-live-3.1:generateContent" in url:
            raise RuntimeError("gemini_live HTTP 503: temporary high demand")
        if "models/gemini-2.5-flash-preview-tts:generateContent" in url:
            raise AssertionError("tts model should not be used for text probe")
        if "models/gemini-exp-text:generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": "AGENTOS_GEMINI_OK"}]}}]}
        raise AssertionError(url)

    monkeypatch.setattr(provider, "_request_json", fake_request_json)

    result = provider.probe_once({"enabled": True, "allow_env_credentials": True, "model": "gemini-live-3.1"})

    assert result["status"] == "passed"
    assert result["probe_model"] == "models/gemini-exp-text"
    assert not any("preview-tts:generateContent" in url for url in calls)


def test_normalize_command_text_falls_back_after_timeout(monkeypatch):
    provider = load_provider()
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    def fake_request_json(url, *, payload=None):
        if url.endswith("/models?key=test-key"):
            return {
                "models": [
                    {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/gemini-2.0-flash", "supportedGenerationMethods": ["generateContent"]},
                ]
            }
        if "models/gemini-2.5-flash:generateContent" in url:
            raise TimeoutError("The read operation timed out")
        if "models/gemini-2.0-flash:generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": '{"command_text":"покажи digest","reason":"digest request"}'}]}}]}
        raise AssertionError(url)

    monkeypatch.setattr(provider, "_request_json", fake_request_json)

    result = provider.normalize_command_text({"enabled": True, "allow_env_credentials": True, "model": "gemini-2.5-flash"}, "дай сводку")

    assert result["normalized_text"] == "покажи digest"
    assert result["model"] == "models/gemini-2.0-flash"
    assert result["fallback_attempts"] == 1
