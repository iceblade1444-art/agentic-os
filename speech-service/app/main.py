"""services/speech — CPU-only STT/TTS for AgenticOS (port 4400).

Same trust model as llm-router: internal service, callers present
x-internal-secret; the NestJS api authenticates humans.
"""
import logging
import time
import os
import tempfile

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response

from . import cache, config, correct, opus, stt, tts

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s %(message)s")

app = FastAPI(title="speech", version="0.1.0")


def _check_secret(x_internal_secret: str | None):
    if config.INTERNAL_SECRET and x_internal_secret != config.INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="bad internal secret")



@app.on_event("startup")
def _preload_voices():
    """Warm the fast voices in the background.

    The first synthesis after a restart pays ~1.3 s to load the piper model,
    while later ones take 0.28 s. Doing it here means the cost lands on nobody
    instead of on whoever calls first. Threaded so startup and /healthz are not
    held up, and failures are logged rather than fatal — a service that answers
    slowly beats one that refuses to start.
    """
    import threading

    def load():
        for language in ("Uzbek", "Russian"):
            try:
                started = time.time()
                tts.synthesize("Salom", language=language, engine="fast")
                log.info("preloaded %s voice in %.2fs", language, time.time() - started)
            except Exception as exc:
                log.warning("preload of %s failed: %s", language, exc)

    threading.Thread(target=load, daemon=True).start()

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/stt")
async def stt_endpoint(
    audio: UploadFile = File(...),
    language: str | None = Form(default=None),
    correct_text: bool = Form(default=False),
    x_internal_secret: str | None = Header(default=None),
):
    _check_secret(x_internal_secret)
    suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        result = stt.transcribe(path, language)
        if correct_text and result.get("text"):
            raw = result["text"]
            result["text"] = correct.correct(raw, result.get("language"))
            result["raw_text"] = raw
        return result
    finally:
        os.unlink(path)


@app.post("/tts")
def tts_endpoint(
    text: str = Form(...),
    language: str | None = Form(default=None),
    speaker: str | None = Form(default=None),
    instruct: str | None = Form(default=None),
    engine: str | None = Form(default=None),
    speed: float | None = Form(default=None),
    # "opus" returns OGG/Opus, which is the only thing Telegram plays as a
    # voice message; anything else arrives as a file to download. The default
    # stays WAV so every existing caller is untouched.
    audio_format: str | None = Form(default=None),
    x_internal_secret: str | None = Header(default=None),
):
    _check_secret(x_internal_secret)
    if not text.strip():
        raise HTTPException(status_code=400, detail="empty text")
    try:
        wav = tts.synthesize(text, language, speaker, instruct, engine, speed)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if (audio_format or "").strip().lower() in {"opus", "ogg", "voice"}:
        try:
            return Response(content=opus.wav_to_opus(wav), media_type="audio/ogg")
        except RuntimeError as exc:
            # The caller asked for a voice message and cannot have one. Say so
            # rather than returning a WAV it would post as an unplayable file.
            raise HTTPException(status_code=503, detail=str(exc))
    return Response(content=wav, media_type="audio/wav")


@app.post("/clone")
async def clone_endpoint(
    ref_audio: UploadFile = File(...),
    text: str = Form(...),
    language: str | None = Form(default=None),
    ref_text: str | None = Form(default=None),
    x_internal_secret: str | None = Header(default=None),
):
    _check_secret(x_internal_secret)
    if not text.strip():
        raise HTTPException(status_code=400, detail="empty text")
    suffix = os.path.splitext(ref_audio.filename or "ref.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await ref_audio.read())
        path = tmp.name
    try:
        wav = tts.clone(text, language, path, ref_text)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    finally:
        os.unlink(path)
    return Response(content=wav, media_type="audio/wav")


# Stock lines an assistant repeats all day. Warmed once, they are served from
# disk in milliseconds even by the slow premium voice.
DEFAULT_PHRASES_UZ = [
    "Assalomu alaykum! Men Milana, sizning yordamchingizman.",
    "Eshitaman sizni.",
    "Ha, albatta. Bir daqiqa, hozir tekshirib ko'raman.",
    "Kechirasiz, buyurtma raqamingizni ayta olasizmi?",
    "Bir daqiqa kuting, hozir aniqlab beraman.",
    "Rahmat! Yaxshi kun tilayman, xayr!",
    "Boshqa savolingiz bormi?",
    "Kechirasiz, sizni tushunmadim. Yana bir bor takrorlaysizmi?",
]


DEFAULT_PHRASES_RU = [
    "Здравствуйте! Меня зовут Милана, я ваш помощник.",
    "Слушаю вас.",
    "Да, конечно. Одну минуту, сейчас проверю.",
    "Извините, подскажите номер вашего заказа?",
    "Одну минуту, сейчас уточню.",
    "Спасибо! Хорошего дня, до свидания!",
    "У вас есть ещё вопросы?",
    "Извините, я вас не расслышала. Повторите, пожалуйста.",
]

DEFAULT_PHRASES_EN = [
    "Hello! My name is Milana, I am your assistant.",
    "I am listening.",
    "Yes, of course. One moment, let me check.",
    "Sorry, could you tell me your order number?",
    "One moment, I will find out right now.",
    "Thank you! Have a good day, goodbye!",
    "Do you have any other questions?",
    "Sorry, I did not catch that. Could you repeat it, please?",
]

STOCK = {"Uzbek": DEFAULT_PHRASES_UZ, "Russian": DEFAULT_PHRASES_RU,
         "English": DEFAULT_PHRASES_EN}


@app.post("/cache/warm")
def warm_endpoint(
    language: str = Form(default="Uzbek"),
    engine: str = Form(default="quality"),
    phrases: str | None = Form(default=None),
    speaker: str | None = Form(default=None),
    instruct: str | None = Form(default=None),
    speed: float | None = Form(default=None),
    x_internal_secret: str | None = Header(default=None),
):
    """Pre-generate phrases (newline-separated) or the built-in stock list.

    The speaker and instruction are part of the cache key, so warming has to use
    the same ones the caller will: warming under speaker="" while the dashboard
    asks for "vivian" generates audio nobody ever reads back.
    """
    _check_secret(x_internal_secret)
    lines = ([p.strip() for p in (phrases or "").splitlines() if p.strip()]
             or STOCK.get(language, DEFAULT_PHRASES_UZ))
    params = {"engine": engine, "language": language, "speaker": speaker or "",
              "instruct": instruct or "", "speed": speed or 1.0}
    stats = cache.warm(
        lambda text, **_: tts.synthesize(text, language, speaker=speaker,
                                         instruct=instruct, engine=engine,
                                         speed=speed),
        lines, **params)
    return {"phrases": len(lines), "language": language, "engine": engine,
            "speaker": speaker or "", **stats}
