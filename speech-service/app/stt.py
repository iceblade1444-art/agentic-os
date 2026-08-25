"""Multi-language STT: one faster-whisper engine, per-language weights.

Models load lazily on first use and stay resident. A missing fine-tune
directory falls back to stock multilingual `small` so the service degrades
instead of failing.
"""
import logging
import os
import threading

from faster_whisper import WhisperModel

from . import config, gpu

log = logging.getLogger("speech.stt")

_models: dict[str, WhisperModel] = {}
_lock = threading.Lock()


def _load(lang: str) -> WhisperModel:
    spec = config.STT_MODELS.get(lang, "small")
    if os.sep in str(spec) and not os.path.isdir(spec):
        log.warning("no fine-tuned model for '%s' at %s — using stock 'small'", lang, spec)
        spec = "small"
    key = str(spec)
    with _lock:
        if key not in _models:
            log.info("loading STT model for '%s': %s", lang, spec)
            _models[key] = WhisperModel(
                spec, device="cpu", compute_type="int8",
                cpu_threads=config.CPU_THREADS,
            )
        return _models[key]


# Beam 5 costs ~25% more CPU and removes an eighth of the word errors
# (21.3% -> 18.8% WER on the uz benchmark). Set STT_BEAM_SIZE=1 to trade the
# accuracy back for latency on live calls.
BEAM_SIZE = int(os.getenv("STT_BEAM_SIZE", "5"))


def transcribe(audio_path: str, language: str | None = None) -> dict:
    """language=None -> detect with the default-language model, then, if the
    detected language has a dedicated fine-tune, redo with that model."""
    lang = language or config.STT_DEFAULT

    # the office GPU is ~6x faster and, running full precision instead of int8,
    # measurably more accurate — but it is someone's desktop, so any failure
    # falls straight through to local compute
    remote = gpu.transcribe(audio_path, language)
    if remote is not None:
        remote["device"] = "gpu"
        return remote

    model = _load(lang)
    segments, info = model.transcribe(
        audio_path,
        language=language,       # None lets whisper detect
        vad_filter=True,
        beam_size=BEAM_SIZE,
        condition_on_previous_text=False,
    )
    seg_list = [(s.start, s.end, s.text.strip()) for s in segments]
    text_parts = [t for _, _, t in seg_list]

    # Re-transcribe only when the detected language has a *different* dedicated
    # model (e.g. kk/ky); the uz fine-tune natively covers uz/ru/en, so the
    # common case stays single-pass.
    detected = info.language
    if language is None and detected != lang and detected in config.STT_MODELS \
            and config.STT_MODELS[detected] != config.STT_MODELS.get(lang):
        model = _load(detected)
        segments, info = model.transcribe(audio_path, language=detected, vad_filter=True,
                                          beam_size=BEAM_SIZE,
                                          condition_on_previous_text=False)
        seg_list = [(s.start, s.end, s.text.strip()) for s in segments]
        text_parts = [t for _, _, t in seg_list]

    return {
        "text": " ".join(text_parts).strip(),
        "language": info.language,
        "duration": round(info.duration, 2),
        "segments": [{"start": round(a, 2), "end": round(b, 2), "text": t}
                     for a, b, t in seg_list],
    }
