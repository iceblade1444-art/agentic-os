"""Send the heavy work to the GPU on the office PC, and cope when it is not there.

Measured against this server's own CPU: recognition 0.48 s against 3.03 s and,
because the card runs full precision instead of int8, 5.0% word errors against
8.8%; the premium voice 1.6 s against 48 s. The fast Uzbek voice already answers
in 0.28 s here and is not worth a network hop.

The PC belongs to a person. It sleeps, reboots, and gets carried away. So this
module treats the GPU as a bonus, never a dependency: one short timeout, any
failure at all falls back to local compute, and a failure is remembered for a
while so that a switched-off PC costs one slow request rather than one per call.
"""
import logging
import os
import time

import requests

log = logging.getLogger("speech.gpu")

URL = os.getenv("GPU_WORKER_URL", "").rstrip("/")
SECRET = os.getenv("GPU_WORKER_SECRET", "")
CONNECT_TIMEOUT = float(os.getenv("GPU_CONNECT_TIMEOUT", "1.5"))
STT_TIMEOUT = float(os.getenv("GPU_STT_TIMEOUT", "120"))
TTS_TIMEOUT = float(os.getenv("GPU_TTS_TIMEOUT", "180"))
# after a failure, stop trying for a while: a sleeping PC should cost one slow
# request, not one per call
COOLDOWN = float(os.getenv("GPU_COOLDOWN", "60"))

_unavailable_until = 0.0


def enabled() -> bool:
    return bool(URL)


def available() -> bool:
    return enabled() and time.time() >= _unavailable_until


def _mark_down(reason: str):
    global _unavailable_until
    _unavailable_until = time.time() + COOLDOWN
    log.info("gpu worker unavailable (%s) — using local cpu for %.0fs",
             reason, COOLDOWN)


def status() -> dict:
    """For /healthz: says whether the card is currently carrying work."""
    if not enabled():
        return {"configured": False}
    if not available():
        return {"configured": True, "reachable": False,
                "retry_in": round(_unavailable_until - time.time())}
    try:
        r = requests.get(f"{URL}/healthz", timeout=CONNECT_TIMEOUT)
        r.raise_for_status()
        return {"configured": True, "reachable": True, **r.json()}
    except Exception as exc:
        _mark_down(type(exc).__name__)
        return {"configured": True, "reachable": False}


def transcribe(audio_path: str, language: str | None):
    """Returns the same shape as local stt.transcribe, or None to fall back."""
    if not available():
        return None
    try:
        with open(audio_path, "rb") as fh:
            r = requests.post(
                f"{URL}/stt",
                files={"audio": (os.path.basename(audio_path), fh)},
                data={"language": language} if language else {},
                headers={"x-worker-secret": SECRET} if SECRET else {},
                timeout=(CONNECT_TIMEOUT, STT_TIMEOUT))
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict) or "text" not in data:
            raise ValueError("unexpected reply")
        return data
    except Exception as exc:
        _mark_down(type(exc).__name__)
        return None


def synthesize(text: str, language: str | None, engine: str):
    """Returns wav bytes, or None to fall back to local synthesis."""
    if not available():
        return None
    try:
        r = requests.post(
            f"{URL}/tts",
            data={"text": text, "language": language or "", "engine": engine},
            headers={"x-worker-secret": SECRET} if SECRET else {},
            timeout=(CONNECT_TIMEOUT, TTS_TIMEOUT))
        r.raise_for_status()
        if len(r.content) < 1000:
            raise ValueError("suspiciously small audio")
        return r.content
    except Exception as exc:
        _mark_down(type(exc).__name__)
        return None
