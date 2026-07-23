import io
import logging
import os
import re
import subprocess
import tempfile
import threading
import wave

import soundfile as sf

from . import config

log = logging.getLogger("speech.tts")

PIPER_DIR = os.path.join(config.MODELS_DIR, "piper")
QWEN_DIR = os.getenv("QWEN_TTS_DIR", "/app/models-qwen")
QWEN_BIN = os.getenv("QWEN_TTS_BIN", "/app/qwen_tts")
CLONE_MODEL = os.getenv("TTS_CLONE_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")

_LANGUAGES = {
    "ru": "Russian",
    "russian": "Russian",
    "en": "English",
    "english": "English",
    "uz": "Uzbek",
    "uzbek": "Uzbek",
}
PIPER_VOICES = {
    "Russian": "ru_RU-irina-medium.onnx",
    "Uzbek": "uz_UZ-milana-medium.onnx",
}

_model = None
_clone_model = None
_model_lock = threading.Lock()
_piper_voices: dict[str, object] = {}

_APOSTROPHES = str.maketrans(
    {"ʻ": "'", "’": "'", "‘": "'", "`": "'", "´": "'", "ʼ": "'"}
)
_CYRILLIC_TO_LATIN = {
    "ў": "o'", "қ": "q", "ғ": "g'", "ҳ": "h", "а": "a", "б": "b",
    "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "x", "ц": "ts", "ч": "ch", "ш": "sh",
    "ъ": "'", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}
_UZBEK_STEMS = [
    "qo'g'irchoq", "ma'lumot", "to'g'ri", "o'zbek", "ro'yxat", "g'alaba",
    "ta'lim", "ko'cha", "so'rov", "o'qituvchi", "o'quvchi", "bo'lim",
    "ko'rsat", "o'tkaz", "mo'ljal", "ko'ngil", "so'z", "ko'z", "ko'p",
    "bo'l", "so'ra", "o'qi", "o'tir", "o'yla", "o'yin", "o'g'il", "g'oya",
    "bog'", "tog'", "yo'l", "yo'q", "ko'r", "bo'sh", "o'n", "o'z", "e'lon",
    "a'lo", "she'r", "fe'l", "mas'ul", "o'rin", "o'rgan", "to'lov", "to'la",
    "so'm", "g'isht", "o'simlik", "ko'tar", "cho'l", "no'xat", "o'rik",
]
_STEM_MAP = sorted(
    ((stem.replace("'", ""), stem) for stem in _UZBEK_STEMS),
    key=lambda item: -len(item[0]),
)


def _normalize_language(language: str | None) -> str:
    return _LANGUAGES.get(
        (language or "").strip().lower(),
        language or "Russian",
    )


def normalize_uzbek(text: str) -> str:
    text = text.translate(_APOSTROPHES)
    if any("а" <= char <= "я" or char in "ўқғҳё" for char in text.lower()):
        converted = []
        for char in text:
            replacement = _CYRILLIC_TO_LATIN.get(char.lower())
            if replacement is None:
                converted.append(char)
            else:
                converted.append(replacement.capitalize() if char.isupper() else replacement)
        text = "".join(converted)

    def fix_word(word: str) -> str:
        lowered = word.lower()
        if "'" in lowered:
            return word
        for bare, full in _STEM_MAP:
            if lowered.startswith(bare):
                fixed = full + lowered[len(bare):]
                return fixed.capitalize() if word[0].isupper() else fixed
        return word

    return re.sub(r"[A-Za-z']+", lambda match: fix_word(match.group(0)), text)


def _piper(text: str, language: str, speed: float | None = None) -> bytes:
    if language == "Uzbek":
        text = normalize_uzbek(text)
    voice = PIPER_VOICES.get(language)
    path = os.path.join(PIPER_DIR, voice or "")
    if not voice or not os.path.exists(path):
        raise RuntimeError(f"no Piper voice for {language}")

    if speed and abs(speed - 1.0) > 0.01:
        scale = max(0.5, min(2.0, 1.0 / speed))
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
            output = temp.name
        try:
            subprocess.run(
                ["piper", "-m", path, "-f", output, "--length-scale", f"{scale:.2f}"],
                input=text.encode("utf-8"),
                check=True,
                timeout=120,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            with open(output, "rb") as audio:
                return audio.read()
        finally:
            os.unlink(output)

    try:
        from piper import PiperVoice

        voice_model = _piper_voices.get(path)
        if voice_model is None:
            log.info("Loading Piper voice %s", os.path.basename(path))
            voice_model = PiperVoice.load(path)
            _piper_voices[path] = voice_model
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            voice_model.synthesize_wav(text, output)
        return buffer.getvalue()
    except Exception as error:
        log.warning("Piper Python API failed (%s); using CLI", error)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
        output = temp.name
    try:
        subprocess.run(
            ["piper", "-m", path, "-f", output],
            input=text.encode("utf-8"),
            check=True,
            timeout=120,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with open(output, "rb") as audio:
            return audio.read()
    finally:
        os.unlink(output)


def _qwen_cli(text: str, language: str, speaker: str) -> bytes:
    if not os.path.isfile(QWEN_BIN) or not os.path.isdir(QWEN_DIR):
        raise RuntimeError("Qwen CLI model is not installed")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
        output = temp.name
    try:
        subprocess.run(
            [
                QWEN_BIN, "-d", QWEN_DIR, "--int8",
                "-s", (speaker or "vivian").lower(),
                "-l", language, "--text", text, "-o", output,
            ],
            check=True,
            timeout=600,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with open(output, "rb") as audio:
            return audio.read()
    finally:
        os.unlink(output)


def _qwen_python(text: str, language: str, speaker: str, instruct: str) -> bytes:
    global _model
    with _model_lock:
        if _model is None:
            import torch
            from qwen_tts import Qwen3TTSModel

            log.info("Loading Python TTS model %s", config.TTS_MODEL)
            _model = Qwen3TTSModel.from_pretrained(
                config.TTS_MODEL,
                device_map=config.TTS_DEVICE,
                dtype=torch.float32,
            )
    options = {
        "text": text,
        "language": language,
        "speaker": speaker or config.TTS_DEFAULT_SPEAKER,
    }
    if instruct:
        options["instruct"] = instruct
    waves, sample_rate = _model.generate_custom_voice(**options)
    buffer = io.BytesIO()
    sf.write(buffer, waves[0], sample_rate, format="WAV")
    return buffer.getvalue()


def clone(
    text: str,
    language: str | None,
    reference_audio: str,
    reference_text: str | None = None,
) -> bytes:
    normalized = _normalize_language(language)
    supported = {
        "Russian", "English", "Chinese", "Japanese", "Korean",
        "German", "French", "Spanish", "Italian", "Portuguese",
    }
    if normalized not in supported:
        raise RuntimeError(f"Voice cloning is not supported for {normalized}")

    global _clone_model
    with _model_lock:
        if _clone_model is None:
            import torch
            from qwen_tts import Qwen3TTSModel

            log.info("Loading clone model %s", CLONE_MODEL)
            _clone_model = Qwen3TTSModel.from_pretrained(
                CLONE_MODEL,
                device_map=config.TTS_DEVICE,
                dtype=torch.float32,
            )
    options = {"text": text, "language": normalized, "ref_audio": reference_audio}
    if reference_text and reference_text.strip():
        options["ref_text"] = reference_text.strip()
    else:
        options["x_vector_only_mode"] = True
    waves, sample_rate = _clone_model.generate_voice_clone(**options)
    buffer = io.BytesIO()
    sf.write(buffer, waves[0], sample_rate, format="WAV")
    return buffer.getvalue()


def synthesize(
    text: str,
    language: str | None = None,
    speaker: str | None = None,
    instruct: str | None = None,
    engine: str | None = None,
    speed: float | None = None,
) -> bytes:
    normalized = _normalize_language(language)
    selected = (engine or ("emotion" if instruct else "fast")).strip().lower()
    log.info("TTS engine=%s language=%s chars=%d", selected, normalized, len(text))

    if selected == "fast" or normalized not in {"Russian", "English"}:
        try:
            return _piper(text, normalized, speed)
        except Exception as error:
            if normalized not in {"Russian", "English"}:
                raise RuntimeError(f"Voice for {normalized} is not installed") from error
            log.warning("Piper failed (%s); falling back to Qwen", error)
            selected = "quality"

    if selected == "quality":
        try:
            return _qwen_cli(text, normalized, speaker or config.TTS_DEFAULT_SPEAKER)
        except RuntimeError:
            return _qwen_python(text, normalized, speaker or config.TTS_DEFAULT_SPEAKER, "")
    return _qwen_python(
        text,
        normalized,
        speaker or config.TTS_DEFAULT_SPEAKER,
        instruct or "",
    )
