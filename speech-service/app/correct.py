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


# The LLM rewrites Uzbek o'/g' as typographic ‘ ʼ ʻ ´, which makes the same word
# unsearchable across transcripts. One spelling on the way out.
_APOS = dict.fromkeys(map(ord, "\u2018\u2019\u02bb\u02bc\u00b4\u0060"), "'")


def fold_apostrophes(text: str) -> str:
    return (text or "").translate(_APOS)


def _clean_artifacts(text: str) -> str:
    """Drop the tails Whisper hallucinates on short clips."""
    junk = (r"\b(musiqa|the story of the|the next|the world|thank you|subscribe|"
            r"продолжение следует|редактор субтитров)\b.*$")
    return re.sub(junk, "", text, flags=re.IGNORECASE).strip(" .,-")

def _bare(w: str) -> str:
    return "".join(c for c in w.lower() if c.isalnum() or c == "'")


def _close(a: str, b: str) -> bool:
    """Same word, respelled — not a different word."""
    a, b = _bare(a), _bare(b)
    if a == b:
        return True
    if not a or not b or abs(len(a) - len(b)) > 3:
        return False
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1] / max(len(a), len(b)) <= 0.34


def _merge_conservative(raw: str, fixed: str) -> str:
    """Take punctuation and near-miss spelling fixes; refuse paraphrase."""
    import difflib

    r, f = raw.split(), fixed.split()
    if not r:
        return fixed
    out = []
    sm = difflib.SequenceMatcher(a=[_bare(w) for w in r], b=[_bare(w) for w in f])
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            out.extend(f[j1:j2])                       # corrected: has punctuation
        elif op == "replace" and (i2 - i1) == (j2 - j1):
            out.extend(f[j1 + k] if _close(r[i1 + k], f[j1 + k]) else r[i1 + k]
                       for k in range(i2 - i1))
        elif op == "replace":
            out.extend(r[i1:i2])                       # reshaped span — keep ours
        elif op == "delete":
            out.extend(r[i1:i2])                       # LLM dropped words: restore
        # op == "insert": words the LLM invented — skipped
    return " ".join(out)


def correct(text: str, language: str | None = None) -> str:
    text = fold_apostrophes(_clean_artifacts(text or ""))
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
        fixed = fold_apostrophes((r.json().get("text") or "").strip())
    except Exception as exc:
        log.warning("LLM correction unavailable (%s) — returning raw text", exc)
        return text

    # guard against the model rewriting instead of repairing
    if not fixed or len(fixed) > len(text) * 1.6 or len(fixed) < len(text) * 0.5:
        log.warning("correction rejected (length drift): %r -> %r", text[:60], fixed[:60])
        return text
    merged = _merge_conservative(text, fixed)
    if merged != fixed:
        log.info("correction trimmed to word-level repairs")
    return merged
