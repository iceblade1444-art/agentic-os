"""Multi-engine TTS.

engine="fast"     — Piper ONNX, ~30x realtime on CPU. For live dialogue.
                    Voices per language in models/piper/ (ru stock now; the
                    custom-trained uz_UZ-milana voice drops in the same way).
engine="quality"  — Qwen3-TTS via the C CLI (int8, AVX-512). Natural prosody,
                    ~2.4x slower than realtime. No emotion instructions.
engine="emotion"  — Qwen3-TTS Python with free-form `instruct`. Slowest;
                    for pre-generated voice-overs. Auto-selected when
                    `instruct` is passed.
"""
import io
import logging
import os
import re
import subprocess
import tempfile
import threading

import soundfile as sf

from . import config
from . import quality

log = logging.getLogger("speech.tts")

PIPER_DIR = os.path.join(config.MODELS_DIR, "piper")
QWEN_DIR = os.getenv("QWEN_TTS_DIR", "/app/models-qwen")
QWEN_BIN = os.getenv("QWEN_TTS_BIN", "/app/qwen_tts")

_LANG = {"ru": "Russian", "russian": "Russian", "en": "English", "english": "English",
         "uz": "Uzbek", "uzbek": "Uzbek"}

PIPER_VOICES = {
    "Russian": "ru_RU-irina-medium.onnx",
    "Uzbek": "uz_UZ-milana-medium.onnx",   # arrives after training
    "English": "ru_RU-irina-medium.onnx",  # placeholder until en voice added
}

CLONE_MODEL = os.getenv("TTS_CLONE_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")

_model = None
_clone_model = None
_lock = threading.Lock()


def _norm_lang(language: str | None) -> str:
    return _LANG.get((language or "").strip().lower(), language or "Russian")


_piper_voices: dict[str, object] = {}

# --- Uzbek text normalization ---------------------------------------------
# People routinely type uz without the special apostrophes (togri, kocha) and
# sometimes in Cyrillic; espeak then produces wrong sounds. Fix the input.
_APOSTROPHES = str.maketrans({"ʻ": "'", "’": "'", "‘": "'", "`": "'", "´": "'", "ʼ": "'"})

_CYR2LAT = {
    "ў": "o'", "қ": "q", "ғ": "g'", "ҳ": "h", "а": "a", "б": "b", "в": "v",
    "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i",
    "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p",
    "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "x", "ц": "ts",
    "ч": "ch", "ш": "sh", "ъ": "'", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}

# frequent stems whose apostrophes people drop; matched as word prefixes
_UZ_STEMS = [
    "qo'g'irchoq", "ma'lumot", "to'g'ri", "o'zbek", "ro'yxat", "g'alaba",
    "ta'lim", "ko'cha", "so'rov", "o'qituvchi", "o'quvchi", "bo'lim",
    "ko'rsat", "o'tkaz", "mo'ljal", "ko'ngil", "so'z", "ko'z", "ko'p",
    "bo'l", "so'ra", "o'qi", "o'tir", "o'yla", "o'yin", "o'g'il", "g'oya",
    "bog'", "tog'", "yo'l", "yo'q", "ko'r", "bo'sh", "o'n", "o'z", "e'lon",
    "a'lo", "she'r", "fe'l", "mas'ul", "o'rin", "o'rgan", "to'lov", "to'la",
    "so'm", "g'isht", "o'simlik", "ko'tar", "cho'l", "no'xat", "o'rik",
]
_STEM_MAP = sorted(((s.replace("'", ""), s) for s in _UZ_STEMS),
                   key=lambda p: -len(p[0]))


def normalize_uz(text: str) -> str:
    text = text.translate(_APOSTROPHES)
    if any("а" <= c <= "я" or c in "ўқғҳё" for c in text.lower()):
        out = []
        for ch in text:
            low = ch.lower()
            rep = _CYR2LAT.get(low)
            if rep is None:
                out.append(ch)
            else:
                out.append(rep.capitalize() if ch.isupper() else rep)
        text = "".join(out)

    def fix_word(word: str) -> str:
        low = word.lower()
        if "'" in low:
            return word
        for bare, full in _STEM_MAP:
            if low.startswith(bare):
                fixed = full + low[len(bare):]
                return fixed.capitalize() if word[0].isupper() else fixed
        return word

    return re.sub(r"[A-Za-z']+", lambda m: fix_word(m.group(0)), text)


def _piper(text: str, language: str, speed: float | None = None) -> bytes:
    if language == "Uzbek":
        text = normalize_uz(text)
    voice = PIPER_VOICES.get(language)
    path = os.path.join(PIPER_DIR, voice or "")
    if not voice or not os.path.exists(path):
        raise RuntimeError(f"no piper voice for {language}")
    # non-default speed goes through the CLI (--length-scale)
    if speed and abs(speed - 1.0) > 0.01:
        scale = max(0.5, min(2.0, 1.0 / speed))
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out = tmp.name
        try:
            subprocess.run(["piper", "-m", path, "-f", out, "--length-scale", f"{scale:.2f}"],
                           input=text.encode("utf-8"), check=True, timeout=120,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with open(out, "rb") as f:
                return f.read()
        finally:
            os.unlink(out)
    # resident model (loads once, then <1s per phrase); CLI subprocess fallback
    try:
        import io
        import wave

        from piper import PiperVoice
        v = _piper_voices.get(path)
        if v is None:
            log.info("loading piper voice %s", os.path.basename(path))
            v = PiperVoice.load(path)
            _piper_voices[path] = v
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            v.synthesize_wav(text, w)
        return buf.getvalue()
    except Exception as exc:
        log.warning("piper python api failed (%s), using CLI", exc)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = tmp.name
    try:
        subprocess.run(["piper", "-m", path, "-f", out],
                       input=text.encode("utf-8"), check=True, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(out, "rb") as f:
            return f.read()
    finally:
        os.unlink(out)


def _qwen_cli(text: str, language: str, speaker: str) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = tmp.name
    try:
        subprocess.run(
            [QWEN_BIN, "-d", QWEN_DIR, "--int8",
             "-s", (speaker or "vivian").lower(), "-l", language,
             "--text", text, "-o", out],
            check=True, timeout=600,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(out, "rb") as f:
            return f.read()
    finally:
        os.unlink(out)


def _qwen_python(text: str, language: str, speaker: str, instruct: str) -> bytes:
    global _model
    with _lock:
        if _model is None:
            import torch
            from qwen_tts import Qwen3TTSModel
            log.info("loading python TTS model %s ...", config.TTS_MODEL)
            _model = Qwen3TTSModel.from_pretrained(
                config.TTS_MODEL, device_map=config.TTS_DEVICE,
                dtype=torch.float32)
            log.info("python TTS model ready")
    kwargs = dict(text=text, language=language,
                  speaker=speaker or config.TTS_DEFAULT_SPEAKER)
    if instruct:
        kwargs["instruct"] = instruct
    wavs, sr = _model.generate_custom_voice(**kwargs)
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV")
    return buf.getvalue()


def clone(text: str, language: str | None, ref_audio_path: str,
          ref_text: str | None = None) -> bytes:
    """Zero-shot voice clone from a 3-10s reference sample (Qwen Base model).
    Works for Qwen's 10 languages (ru/en included; uz is served by the
    custom-trained piper voice instead)."""
    lang_norm = _norm_lang(language)
    if lang_norm not in ("Russian", "English", "Chinese", "Japanese", "Korean",
                         "German", "French", "Spanish", "Italian", "Portuguese"):
        raise RuntimeError(
            f"Клонирование не поддерживает язык «{lang_norm}» — движок Qwen знает "
            "только 10 языков (русский, английский и др.). Узбекский голос под "
            "конкретного человека делается дообучением модели Миланы на его записях "
            "(нужно 30-60 минут чистого аудио) — спроси об этом ассистента.")
    global _clone_model
    with _lock:
        if _clone_model is None:
            import torch
            from qwen_tts import Qwen3TTSModel
            log.info("loading clone TTS model %s ...", CLONE_MODEL)
            _clone_model = Qwen3TTSModel.from_pretrained(
                CLONE_MODEL, device_map=config.TTS_DEVICE, dtype=torch.float32)
            log.info("clone TTS model ready")
    kwargs = dict(text=text, language=lang_norm, ref_audio=ref_audio_path)
    if ref_text and ref_text.strip():
        kwargs["ref_text"] = ref_text.strip()
    else:
        kwargs["x_vector_only_mode"] = True
    wavs, sr = _clone_model.generate_voice_clone(**kwargs)
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV")
    return buf.getvalue()


def synthesize(text: str, language: str | None = None, speaker: str | None = None,
               instruct: str | None = None, engine: str | None = None,
               speed: float | None = None, verify: bool | None = None) -> bytes:
    lang = _norm_lang(language)
    # respell names the voice has never heard (Milana -> Milaana, ...)
    text = quality.normalize_for_tts(text, lang)
    eng = (engine or "").strip().lower()
    if not eng:
        eng = "emotion" if instruct else "fast"
    log.info("tts engine=%s lang=%s chars=%d", eng, lang, len(text))
    # Qwen engines cover 10 languages (ru/en among them) but NOT uz/kk/ky —
    # for those the piper voice file is the only backend, so a missing file
    # must produce a clear message instead of a broken fallback.
    piper_only = lang not in ("Russian", "English")
    if eng == "fast" or piper_only:
        try:
            return _piper(text, lang, speed)
        except Exception as exc:
            if piper_only:
                raise RuntimeError(
                    f"Голос для языка «{lang}» ещё обучается и скоро появится. "
                    f"Пока доступны: русский и английский.") from exc
            log.warning("piper failed (%s), falling back to quality", exc)
            eng = "quality"
    # Neural engines occasionally eat a word; piper is deterministic so a
    # retry would return the same audio — verify only the stochastic ones.
    do_verify = bool(verify) if verify is not None else True

    if eng == "quality":
        if not do_verify:
            return _qwen_cli(text, lang, speaker)
        return quality.synthesize_verified(
            lambda text, language, seed, **kw: _qwen_cli(text, _norm_lang(language), speaker),
            text, lang, max_attempts=2)
    if not do_verify:
        return _qwen_python(text, lang, speaker, instruct or "")
    return quality.synthesize_verified(
        lambda text, language, seed, **kw: _qwen_python(text, _norm_lang(language), speaker, instruct or ""),
        text, lang, max_attempts=2)
