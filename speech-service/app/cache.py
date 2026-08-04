"""Phrase cache for synthesized speech.

An assistant repeats itself constantly — greetings, "one moment", price lines,
closings. Generating those once and replaying the file turns the slow premium
voice into an instant one for most of a real conversation.

Keyed by everything that changes the audio, so a config change never serves a
stale voice.
"""
import hashlib
import json
import logging
import os
import pathlib
import threading
import time

log = logging.getLogger("speech.cache")

DIR = pathlib.Path(os.getenv("TTS_CACHE_DIR", "/app/models/tts-cache"))
MAX_ENTRIES = int(os.getenv("TTS_CACHE_MAX", "2000"))
_lock = threading.Lock()


def _key(text: str, **params) -> str:
    payload = json.dumps({"text": text.strip(), **params}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def get(text: str, **params) -> bytes | None:
    path = DIR / f"{_key(text, **params)}.wav"
    if not path.exists():
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    os.utime(path, None)                       # mark as recently used
    log.info("cache hit (%d bytes)", len(data))
    return data


def put(text: str, wav: bytes, **params) -> None:
    if not wav:
        return
    DIR.mkdir(parents=True, exist_ok=True)
    path = DIR / f"{_key(text, **params)}.wav"
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_bytes(wav)
        tmp.replace(path)                      # atomic: readers never see a partial file
    except OSError as exc:
        log.warning("cache write failed: %s", exc)
        return
    with _lock:
        _evict()


def _evict() -> None:
    files = sorted(DIR.glob("*.wav"), key=lambda p: p.stat().st_atime)
    for old in files[:-MAX_ENTRIES]:
        try:
            old.unlink()
        except OSError:
            pass


def warm(synth, phrases: list[str], **params) -> dict:
    """Pre-generate the assistant's stock lines so they are instant in a call."""
    made, skipped, t0 = 0, 0, time.time()
    for text in phrases:
        if get(text, **params):
            skipped += 1
            continue
        try:
            put(text, synth(text=text, **params), **params)
            made += 1
        except Exception as exc:
            log.warning("warm failed for %r: %s", text[:40], exc)
    return {"generated": made, "already_cached": skipped,
            "seconds": round(time.time() - t0, 1)}
