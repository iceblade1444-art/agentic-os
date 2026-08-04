"""Quality gate for synthesized speech.

Modern neural TTS occasionally drops or mangles a word (a known robustness
issue of attention-based text/audio alignment, worst on names and unseen
words). We already run strong ASR in this service, so we check our own output:
synthesize -> transcribe -> compare with the input text; if a word was eaten,
regenerate with a different seed.
"""
import logging
import re
import tempfile
import os

from . import stt

log = logging.getLogger("speech.quality")

# Foreign names/loanwords the Uzbek voice has never seen: respell them the way
# they should sound. Keys are matched case-insensitively as whole words.
RESPELL_UZ = {
    "milana": "Milanna",
    "whatsapp": "Votsap",
    "google": "Gugl",
    "telegram": "Telegramm",
    "instagram": "Instagramm",
}

_WORD = re.compile(r"[A-Za-zА-Яа-яЁё''`]+")


def normalize_for_tts(text: str, language: str | None = None) -> str:
    """Respell known-hard words. Uzbek only — ru/en voices handle them fine."""
    if (language or "").lower() not in ("uzbek", "uz"):
        return text

    def sub(m: re.Match) -> str:
        w = m.group(0)
        rep = RESPELL_UZ.get(w.lower())
        if not rep:
            return w
        return rep.upper() if w.isupper() else (rep if w[0].islower() else rep.capitalize())

    return _WORD.sub(sub, text)


def _norm(s: str) -> str:
    s = s.lower().replace("ʻ", "'").replace("’", "'").replace("`", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^a-zа-яё' ]+", " ", s)).strip()


def prefix_cer(reference: str, heard: str) -> float:
    """Edit distance of `reference` against the best-matching prefix of `heard`
    (ASR often hallucinates a tail on short clips — that must not count)."""
    a, b = _norm(reference), _norm(heard)
    if not a:
        return 0.0
    if not b:
        return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return min(prev) / len(a)


def check(wav_bytes: bytes, text: str, language: str | None = None) -> tuple[float, str]:
    """Transcribe our own audio and score it against the text we asked for."""
    lang = {"uzbek": "uz", "russian": "ru", "english": "en"}.get((language or "").lower())
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        path = tmp.name
    try:
        result = stt.transcribe(path, lang)
    finally:
        os.unlink(path)
    heard = result.get("text", "")
    return prefix_cer(text, heard), heard


def synthesize_verified(synth, text: str, language: str | None = None,
                        max_attempts: int = 3, threshold: float = 0.15, **kwargs) -> bytes:
    """Call `synth(text, seed=...)` until the audio actually says the text.

    Returns the best attempt even if none clears the threshold — never fails
    the caller, just logs what happened.
    """
    best_wav, best_cer, best_heard = None, 1.0, ""
    for attempt in range(1, max_attempts + 1):
        wav = synth(text=text, language=language, seed=attempt * 1000 + 7, **kwargs)
        try:
            cer, heard = check(wav, text, language)
        except Exception as exc:                      # never block on the check
            log.warning("quality check failed (%s) — returning audio as is", exc)
            return wav
        log.info("attempt %d/%d: CER %.3f", attempt, max_attempts, cer)
        if cer < best_cer:
            best_wav, best_cer, best_heard = wav, cer, heard
        if cer <= threshold:
            return wav
    log.warning("kept best of %d attempts: CER %.3f | asked: %r | heard: %r",
                max_attempts, best_cer, text[:80], best_heard[:80])
    return best_wav
