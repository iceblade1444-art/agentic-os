import os

PORT = int(os.getenv("SPEECH_PORT", "4400"))
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "")

# CPU budget per transcription worker; the DL380 (48c/96t) comfortably runs
# several workers in parallel.
CPU_THREADS = int(os.getenv("SPEECH_CPU_THREADS", "8"))

MODELS_DIR = os.getenv("SPEECH_MODELS_DIR", os.path.join(os.path.dirname(__file__), "..", "models"))

# Per-language STT weights. Values are either a CTranslate2 model directory
# (converted fine-tunes, see README) or a stock faster-whisper size name.
# uz model also covers ru/en well; kk fine-tune is large-v3-turbo class.
STT_MODELS = {
    "uz": os.getenv("STT_MODEL_UZ", os.path.join(MODELS_DIR, "whisper-small-uz-ct2")),
    "kk": os.getenv("STT_MODEL_KK", os.path.join(MODELS_DIR, "whisper-kk-turbo-ct2")),
    "ky": os.getenv("STT_MODEL_KY", os.path.join(MODELS_DIR, "whisper-small-ky-ct2")),
    # live-mic audio needs the big model for ru/en accuracy (small is fine for
    # clean audio but falls apart on noisy short phrases); auto-detect does the
    # first pass on the uz model and re-runs ru/en on turbo automatically
    "ru": os.getenv("STT_MODEL_RU", "large-v3-turbo"),
    "en": os.getenv("STT_MODEL_EN", "large-v3-turbo"),
}
STT_DEFAULT = os.getenv("STT_DEFAULT_LANG", "uz")

TTS_MODEL = os.getenv("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
TTS_DEVICE = os.getenv("TTS_DEVICE", "cpu")
TTS_DEFAULT_LANGUAGE = os.getenv("TTS_DEFAULT_LANGUAGE", "Russian")
TTS_DEFAULT_SPEAKER = os.getenv("TTS_DEFAULT_SPEAKER", "Vivian")
