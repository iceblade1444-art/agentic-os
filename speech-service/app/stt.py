import logging
import os
import threading

from faster_whisper import WhisperModel

from . import config

log = logging.getLogger("speech.stt")
_models: dict[str, WhisperModel] = {}
_lock = threading.Lock()


def _load(lang: str) -> WhisperModel:
    spec = config.STT_MODELS.get(lang, "small")
    if os.sep in str(spec) and not os.path.isdir(spec):
        log.warning("No fine-tuned model for %s at %s; using stock small", lang, spec)
        spec = "small"
    key = str(spec)
    with _lock:
        if key not in _models:
            log.info("Loading STT model for %s: %s", lang, spec)
            _models[key] = WhisperModel(
                spec,
                device="cpu",
                compute_type="int8",
                cpu_threads=config.CPU_THREADS,
            )
        return _models[key]


def transcribe(audio_path: str, language: str | None = None) -> dict:
    lang = language or config.STT_DEFAULT
    segments, info = _load(lang).transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
    )
    segment_list = [(s.start, s.end, s.text.strip()) for s in segments]

    detected = info.language
    if (
        language is None
        and detected != lang
        and detected in config.STT_MODELS
        and config.STT_MODELS[detected] != config.STT_MODELS.get(lang)
    ):
        segments, info = _load(detected).transcribe(
            audio_path,
            language=detected,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        segment_list = [(s.start, s.end, s.text.strip()) for s in segments]

    return {
        "text": " ".join(text for _, _, text in segment_list).strip(),
        "language": info.language,
        "duration": round(info.duration, 2),
        "segments": [
            {"start": round(start, 2), "end": round(end, 2), "text": text}
            for start, end, text in segment_list
        ],
    }
