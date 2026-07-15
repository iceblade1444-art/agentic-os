"""Gemini Live provider boundary for AgentOS voice.

This module keeps Gemini Live as a credential-safe provider boundary. It now
supports a safe connectivity probe and mock recognition hooks for testing, but
it still does not open a realtime audio session.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

DEFAULT_MODEL = "gemini-live-3.1"
DEFAULT_TEXT_PROBE_CANDIDATES = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
]
API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
PROBE_PROMPT = "Reply with exactly AGENTOS_GEMINI_OK"


def _key_envs(config: dict[str, Any]) -> tuple[str, str]:
    return (
        config.get("api_key_env", "GEMINI_API_KEY"),
        config.get("fallback_api_key_env", "GOOGLE_API_KEY"),
    )


def _api_key(config: dict[str, Any]) -> str | None:
    if not bool(config.get("allow_env_credentials", False)):
        return None
    primary_env, fallback_env = _key_envs(config)
    return os.getenv(primary_env) or os.getenv(fallback_env)


def _normalize_model_name(name: str) -> str:
    return name if name.startswith("models/") else f"models/{name}"


def _request_json(url: str, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
            message = parsed.get("error", {}).get("message") or body
        except Exception:  # noqa: BLE001 - best-effort error surfacing
            message = body
        raise RuntimeError(f"gemini_live HTTP {exc.code}: {message}") from exc


def provider_status(config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    key_env, fallback_env = _key_envs(config)
    allow_env_credentials = bool(config.get("allow_env_credentials", False))
    has_primary = bool(os.getenv(key_env)) if allow_env_credentials else False
    has_fallback = bool(os.getenv(fallback_env)) if allow_env_credentials else False
    has_key = has_primary or has_fallback
    enabled = bool(config.get("enabled", False))
    missing = []
    if not has_primary:
        missing.append(key_env)
    if not has_fallback:
        missing.append(fallback_env)
    return {
        "provider": "gemini_live",
        "mode": "voice_to_voice",
        "model": config.get("model", DEFAULT_MODEL),
        "enabled": enabled,
        "allow_env_credentials": allow_env_credentials,
        "has_key": has_key,
        "ready": bool(enabled and has_key),
        "missing": [] if has_key else missing,
        "transport": config.get("transport", "websocket_or_sdk"),
        "note": "Ready means credentials+enabled only; realtime SDK transport stays behind a safe probe until full audio wiring is added.",
    }


def _list_models(config: dict[str, Any]) -> list[dict[str, Any]]:
    key = _api_key(config)
    if not key:
        raise RuntimeError("gemini_live requires GEMINI_API_KEY or GOOGLE_API_KEY")
    data = _request_json(f"{API_ROOT}/models?key={key}")
    return data.get("models", [])


def _probe_model_candidates(config: dict[str, Any], models: list[dict[str, Any]]) -> list[str]:
    candidates = []
    if config.get("probe_model"):
        candidates.append(str(config["probe_model"]))
    if config.get("model"):
        candidates.append(str(config["model"]))
    candidates.extend(DEFAULT_TEXT_PROBE_CANDIDATES)

    def supports_generate_content(item: dict[str, Any]) -> bool:
        methods = item.get("supportedGenerationMethods") or []
        name = str(item.get("name", "")).lower()
        text_incompatible_markers = ["tts", "imagen", "image-generation", "embedding", "aqa", "veo"]
        if any(marker in name for marker in text_incompatible_markers):
            return False
        return "generateContent" in methods

    indexed = {}
    for item in models:
        name = str(item.get("name", ""))
        if not name:
            continue
        indexed[name] = item
        indexed[name.removeprefix("models/")] = item

    selected: list[str] = []
    seen: set[str] = set()

    def add_model(name: str) -> None:
        normalized = _normalize_model_name(name)
        if normalized not in seen:
            selected.append(normalized)
            seen.add(normalized)

    for candidate in candidates:
        item = indexed.get(candidate) or indexed.get(candidate.removeprefix("models/"))
        if item and supports_generate_content(item):
            add_model(str(item["name"]))

    for item in models:
        if supports_generate_content(item):
            add_model(str(item["name"]))

    if not selected:
        raise RuntimeError("gemini_live probe could not find a generateContent-capable model")
    return selected


def _pick_probe_model(config: dict[str, Any], models: list[dict[str, Any]]) -> str:
    return _probe_model_candidates(config, models)[0]


def _is_retryable_gemini_error(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    message = str(exc).lower()
    return any(marker in message for marker in [
        "http 429",
        "http 500",
        "http 502",
        "http 503",
        "http 504",
        "high demand",
        "temporarily unavailable",
        "temporary",
        "timed out",
        "timeout",
    ])


def _extract_text(response: dict[str, Any]) -> str:
    for candidate in response.get("candidates", []):
        content = candidate.get("content") or {}
        for part in content.get("parts", []):
            text = part.get("text")
            if text:
                return str(text).strip()
    raise RuntimeError("gemini_live probe returned no text")


def probe_once(config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    mock = os.getenv("AGENTOS_GEMINI_PROBE_MOCK")
    if mock:
        return {
            "provider": "gemini_live",
            "status": "passed",
            "probe_model": config.get("probe_model") or config.get("model", DEFAULT_MODEL),
            "probe_response": mock,
            "transport": "mock-probe",
        }

    status = provider_status(config)
    if not status["has_key"]:
        raise RuntimeError("gemini_live requires GEMINI_API_KEY or GOOGLE_API_KEY")
    if not status["enabled"]:
        raise RuntimeError("gemini_live provider is configured but disabled in config/voice.json")

    models = _list_models(config)
    key = _api_key(config)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": PROBE_PROMPT}]}],
        "generationConfig": {"temperature": 0},
    }
    retryable_errors: list[str] = []
    for probe_model in _probe_model_candidates(config, models):
        try:
            response = _request_json(f"{API_ROOT}/{_normalize_model_name(probe_model)}:generateContent?key={key}", payload=payload)
            return {
                "provider": "gemini_live",
                "status": "passed",
                "probe_model": _normalize_model_name(probe_model),
                "probe_response": _extract_text(response),
                "transport": "rest-probe",
                "fallback_attempts": len(retryable_errors),
            }
        except Exception as exc:  # noqa: BLE001 - retry only known transient Gemini/transport failures
            if not _is_retryable_gemini_error(exc):
                raise
            retryable_errors.append(f"{_normalize_model_name(probe_model)}: {exc}")
    raise RuntimeError("gemini_live probe failed for all retryable model candidates: " + " | ".join(retryable_errors))


def _extract_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            raise RuntimeError(f"gemini_live normalization returned non-JSON text: {text[:200]}")
        return json.loads(match.group(0))


def normalize_command_text(config: dict[str, Any] | None, user_text: str) -> dict[str, Any]:
    config = config or {}
    mock = os.getenv("AGENTOS_GEMINI_NORMALIZE_MOCK")
    if mock is not None:
        return {
            "provider": "gemini_live",
            "normalized_text": mock.strip(),
            "model": config.get("model", DEFAULT_MODEL),
            "transport": "mock-normalize",
        }

    status = provider_status(config)
    if not status["has_key"]:
        raise RuntimeError("gemini_live requires GEMINI_API_KEY or GOOGLE_API_KEY")
    if not status["enabled"]:
        raise RuntimeError("gemini_live provider is configured but disabled in config/voice.json")

    models = _list_models(config)
    key = _api_key(config)
    prompt = (
        "Normalize the user's Russian/English spoken-style request into a safe AgentOS command.\n"
        "Allowed command_text outputs:\n"
        "1. показать digest must be exactly: покажи digest\n"
        "2. create a goal must be exactly: создай goal <short goal title>\n"
        "3. anything else must be exactly: unknown\n"
        "Return JSON only: {\"command_text\":\"...\",\"reason\":\"...\"}\n"
        f"User request: {user_text}"
    )
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    retryable_errors: list[str] = []
    for model in _probe_model_candidates(config, models):
        try:
            response = _request_json(f"{API_ROOT}/{_normalize_model_name(model)}:generateContent?key={key}", payload=payload)
            parsed = _extract_json_object(_extract_text(response))
            normalized = str(parsed.get("command_text", "")).strip()
            if not normalized:
                raise RuntimeError("gemini_live normalization returned empty command_text")
            return {
                "provider": "gemini_live",
                "normalized_text": normalized,
                "reason": parsed.get("reason"),
                "model": _normalize_model_name(model),
                "transport": "rest-normalize",
                "fallback_attempts": len(retryable_errors),
            }
        except Exception as exc:  # noqa: BLE001 - retry only known transient Gemini/transport failures
            if not _is_retryable_gemini_error(exc):
                raise
            retryable_errors.append(f"{_normalize_model_name(model)}: {exc}")
    raise RuntimeError("gemini_live normalization failed for all retryable model candidates: " + " | ".join(retryable_errors))


def generate_chat_reply(config: dict[str, Any] | None, user_text: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    context = context or {}
    status = provider_status(config)
    if not status["has_key"]:
        raise RuntimeError("gemini_live requires GEMINI_API_KEY or GOOGLE_API_KEY")
    if not status["enabled"]:
        raise RuntimeError("gemini_live provider is configured but disabled in config/voice.json")

    models = _list_models(config)
    key = _api_key(config)
    prompt = (
        "You are Mila, the single AgentOS orchestrator and voice-first local assistant.\n"
        "Speak Russian by default. If the user writes in another language, reply in that language.\n"
        "Be warm, concise, useful, and natural. Do not answer with command examples unless the user asks how commands work.\n"
        "You can discuss tasks, explain what you can do, and help the user shape goals.\n"
        "If the user clearly asks to create/run/export/request approval, keep the reply short because AgentOS may execute it separately.\n"
        "Never reveal or ask for raw API keys.\n"
        f"Workspace status: projects={context.get('projects', 0)}, pending_approvals={context.get('pending_approvals', 0)}, queue_items={context.get('queue_items', 0)}.\n"
        f"User: {user_text}\n"
        "Mila:"
    )
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 420},
    }
    retryable_errors: list[str] = []
    for model in _probe_model_candidates(config, models):
        try:
            response = _request_json(f"{API_ROOT}/{_normalize_model_name(model)}:generateContent?key={key}", payload=payload)
            return {
                "provider": "gemini_live",
                "reply": _extract_text(response).strip(),
                "model": _normalize_model_name(model),
                "transport": "rest-chat",
                "fallback_attempts": len(retryable_errors),
            }
        except Exception as exc:  # noqa: BLE001 - retry only known transient Gemini/transport failures
            if not _is_retryable_gemini_error(exc):
                raise
            retryable_errors.append(f"{_normalize_model_name(model)}: {exc}")
    raise RuntimeError("gemini_live chat failed for all retryable model candidates: " + " | ".join(retryable_errors))


def recognize_once(config: dict[str, Any] | None = None) -> str:
    config = config or {}
    mock_text = os.getenv("AGENTOS_GEMINI_RECOGNIZE_MOCK")
    if mock_text:
        return mock_text.strip()
    status = provider_status(config)
    if not status["has_key"]:
        raise RuntimeError("gemini_live requires GEMINI_API_KEY or GOOGLE_API_KEY")
    if not status["enabled"]:
        raise RuntimeError("gemini_live provider is configured but disabled in config/voice.json")
    raise NotImplementedError("gemini_live realtime SDK/WebSocket transport is not wired yet")
