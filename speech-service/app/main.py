import logging
import os
import tempfile

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response

from . import config, stt, tts

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)

app = FastAPI(title="Agentic OS Speech", version="0.2.0")


def _check_secret(value: str | None):
    if config.INTERNAL_SECRET and value != config.INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="invalid internal secret")


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "agentic-os-speech", "version": "0.2.0"}


@app.post("/stt")
async def stt_endpoint(
    audio: UploadFile = File(...),
    language: str | None = Form(default=None),
    x_internal_secret: str | None = Header(default=None),
):
    _check_secret(x_internal_secret)
    suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        temp.write(await audio.read())
        path = temp.name
    try:
        return stt.transcribe(path, language)
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
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
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
    suffix = os.path.splitext(ref_audio.filename or "reference.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        temp.write(await ref_audio.read())
        path = temp.name
    try:
        wav = tts.clone(text, language, path, ref_text)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    finally:
        os.unlink(path)
    return Response(content=wav, media_type="audio/wav")
