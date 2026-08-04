"""LLM post-correction of ASR output.

Recognition gets the sounds right but stumbles on names, numbers, borrowed
words and punctuation. The assistant already has an LLM router, so we hand it
the raw transcript and ask for a minimal repair — this typically removes a
noticeable share of the remaining errors in every language at once.
"""
import logging
import os
import re

import httpx

log = logging.getLogger("speech.correct")

LLM_URL = os.getenv("LLM_COMPLETE_URL", "http://agentic-os:8787/api/llm/complete")
LLM_TOKEN = os.getenv("LLM_INTERNAL_SECRET") or os.getenv("LLM_INTERNAL_TOKEN", "")
TIMEOUT = float(os.getenv("CORRECT_TIMEOUT", "20"))

LANG_NAMES = {"uz": "узбекском (латиница)", "ru": "русском", "en": "английском"}

PROMPT = """Ты — корректор расшифровок речи. Ниже текст, полученный автоматическим распознаванием на {lang}.

Исправь ТОЛЬКО очевидные ошибки распознавания:
- искажённые слова, имена собственные, названия компаний;
- числа, даты, суммы, телефоны — записывай цифрами;
- расставь пунктуацию и заглавные буквы;
- убери артефакты распознавания (повторы, обрывки на чужом языке в конце).

ЗАПРЕЩЕНО: перефразировать, сокращать, дополнять смыслом, переводить.
Если текст уже корректен — верни его без изменений.
Верни ТОЛЬКО исправленный текст, без пояснений.

Текст: {text}"""


def _clean_artifacts(text: str) -> str:
    """Drop the tails Whisper hallucinates on short clips."""
    junk = (r"\b(musiqa|the story of the|the next|the world|thank you|subscribe|"
            r"продолжение следует|редактор субтитров)\b.*$")
    return re.sub(junk, "", text, flags=re.IGNORECASE).strip(" .,-")


def correct(text: str, language: str | None = None) -> str:
    text = _clean_artifacts(text or "")
    if len(text.split()) < 2:
        return text
    lang = LANG_NAMES.get((language or "").lower(), "узбекском (латиница)")
    try:
        headers = {"Content-Type": "application/json"}
        if LLM_TOKEN:
            headers["x-internal-secret"] = LLM_TOKEN     # matches the app's bypass
        r = httpx.post(LLM_URL, headers=headers, timeout=TIMEOUT, json={
            "prompt": PROMPT.format(lang=lang, text=text),
            "temperature": 0,
        })
        r.raise_for_status()
        fixed = (r.json().get("text") or "").strip()
    except Exception as exc:
        log.warning("LLM correction unavailable (%s) — returning raw text", exc)
        return text

    # guard against the model rewriting instead of repairing
    if not fixed or len(fixed) > len(text) * 1.6 or len(fixed) < len(text) * 0.5:
        log.warning("correction rejected (length drift): %r -> %r", text[:60], fixed[:60])
        return text
    return fixed
