"""services/speech — CPU-only STT/TTS for AgenticOS (port 4400).

Same trust model as llm-router: internal service, callers present
x-internal-secret; the NestJS api authenticates humans.
"""
import logging
import os
import tempfile

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response

from . import cache, config, correct, stt, tts

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s %(message)s")

app = FastAPI(title="speech", version="0.1.0")


def _check_secret(x_internal_secret: str | None):
    if config.INTERNAL_SECRET and x_internal_secret != config.INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="bad internal secret")


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
    x_internal_secret: str | None = Header(default=None),
):
    _check_secret(x_internal_secret)
    if not text.strip():
        raise HTTPException(status_code=400, detail="empty text")
    try:
        wav = tts.synthesize(text, language, speaker, instruct, engine, speed)
    except RuntimeError as exc:
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


@app.post("/cache/warm")
def warm_endpoint(
    language: str = Form(default="Uzbek"),
    engine: str = Form(default="quality"),
    phrases: str | None = Form(default=None),
    x_internal_secret: str | None = Header(default=None),
):
    """Pre-generate phrases (newline-separated) or the built-in stock list."""
    _check_secret(x_internal_secret)
    lines = [p.strip() for p in (phrases or "").splitlines() if p.strip()] or DEFAULT_PHRASES_UZ
    params = {"engine": engine, "language": language, "speaker": "",
              "instruct": "", "speed": 1.0}
    stats = cache.warm(
        lambda text, **_: tts.synthesize(text, language, engine=engine),
        lines, **params)
    return {"phrases": len(lines), **stats}
