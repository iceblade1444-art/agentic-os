import os

INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "")
CPU_THREADS = int(os.getenv("SPEECH_CPU_THREADS", "8"))
MODELS_DIR = os.getenv(
    "SPEECH_MODELS_DIR",
    os.path.join(os.path.dirname(__file__), "..", "models"),
)

STT_MODELS = {
    "uz": os.getenv("STT_MODEL_UZ", os.path.join(MODELS_DIR, "whisper-small-uz-ct2")),
    "kk": os.getenv("STT_MODEL_KK", os.path.join(MODELS_DIR, "whisper-kk-turbo-ct2")),
    "ky": os.getenv("STT_MODEL_KY", os.path.join(MODELS_DIR, "whisper-small-ky-ct2")),
    "ru": os.getenv("STT_MODEL_RU", "large-v3-turbo"),
    "en": os.getenv("STT_MODEL_EN", "large-v3-turbo"),
}
STT_DEFAULT = os.getenv("STT_DEFAULT_LANG", "uz")

TTS_MODEL = os.getenv("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
TTS_DEVICE = os.getenv("TTS_DEVICE", "cpu")
TTS_DEFAULT_SPEAKER = os.getenv("TTS_DEFAULT_SPEAKER", "Vivian")
