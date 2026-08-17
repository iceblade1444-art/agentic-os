"""Telegram front end for our speech service.

Long polling rather than a webhook: no public route to expose, no TLS
certificate to manage, and it keeps working if the domain or proxy changes.

Transcription is CPU-bound and the speech service serialises it internally, so
the worker pool is deliberately small — queueing there is honest, while
accepting ten jobs at once would only make everyone wait longer without
telling them.
"""
import io
import json
import logging
import os
import pathlib
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor

import requests

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)-7s %(name)s %(message)s")
log = logging.getLogger("speech.bot")

# deliberately not TELEGRAM_BOT_TOKEN: that drives the Agentic OS integration,
# and two long-polling clients on one bot split the updates between them
TOKEN = os.getenv("SPEECH_TELEGRAM_BOT_TOKEN", "").strip()
API = f"https://api.telegram.org/bot{TOKEN}"
FILE_API = f"https://api.telegram.org/file/bot{TOKEN}"
SPEECH_URL = os.getenv("SPEECH_URL", "http://speech:4400")
SECRET = os.getenv("INTERNAL_SECRET", "")
STATE_PATH = pathlib.Path(os.getenv("BOT_STATE", "/data/bot_state.json"))

# empty list = open to everyone; ids here restrict it to a known group
ALLOWED = {int(x) for x in os.getenv("TELEGRAM_ALLOWED_IDS", "").replace(" ", "").split(",") if x}
RATE_PER_HOUR = int(os.getenv("TELEGRAM_RATE_PER_HOUR", "60"))
MAX_BYTES = 20 * 1024 * 1024          # Telegram's getFile ceiling

LANGS = {"uz": "O'zbekcha", "ru": "Русский", "en": "English",
         "kk": "Қазақша", "ky": "Кыргызча", "auto": "определять самому"}
DEFAULT_LANG = os.getenv("BOT_DEFAULT_LANG", "uz")

HELP = (
    "Пришлите голосовое сообщение или аудиофайл — верну текст.\n\n"
    "Понимаю голосовые, кружки, музыкальные файлы и документы со звуком.\n\n"
    "Команды:\n"
    "/lang — выбрать язык распознавания\n"
    "/help — эта справка"
)

_lock = threading.Lock()
_state = {"lang": {}}
_hits = defaultdict(deque)


def load_state():
    global _state
    try:
        _state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        _state.setdefault("lang", {})
    except Exception:
        _state = {"lang": {}}


def save_state():
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATE_PATH)
    except Exception as exc:
        log.warning("не удалось сохранить настройки: %s", exc)


def user_lang(uid) -> str:
    return _state["lang"].get(str(uid), DEFAULT_LANG)


def rate_ok(uid) -> bool:
    now = time.time()
    q = _hits[uid]
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= RATE_PER_HOUR:
        return False
    q.append(now)
    return True


def call(method, **params):
    try:
        r = requests.post(f"{API}/{method}", json=params, timeout=60)
        return r.json()
    except Exception as exc:
        log.warning("%s не прошёл: %s", method, exc)
        return {}


def send(chat_id, text, **extra):
    return call("sendMessage", chat_id=chat_id, text=text[:4000],
                disable_web_page_preview=True, **extra)


def send_document(chat_id, name, content, caption=""):
    try:
        requests.post(f"{API}/sendDocument",
                      data={"chat_id": chat_id, "caption": caption[:1000]},
                      files={"document": (name, io.BytesIO(content))}, timeout=120)
    except Exception as exc:
        log.warning("не удалось отправить файл: %s", exc)


def lang_keyboard():
    row, rows = [], []
    for code, title in LANGS.items():
        row.append({"text": title, "callback_data": f"lang:{code}"})
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    return {"inline_keyboard": rows}


def pick_audio(msg):
    """Telegram delivers speech under four different keys."""
    for key in ("voice", "audio", "video_note", "video"):
        if key in msg:
            return msg[key], key
    doc = msg.get("document")
    if doc and (doc.get("mime_type", "").startswith(("audio/", "video/"))):
        return doc, "document"
    return None, None


def download(file_id):
    info = call("getFile", file_id=file_id)
    path = (info.get("result") or {}).get("file_path")
    if not path:
        return None, None
    r = requests.get(f"{FILE_API}/{path}", timeout=300)
    r.raise_for_status()
    return r.content, path.split("/")[-1]


def transcribe(content, filename, lang):
    data = {}
    if lang != "auto":
        data["language"] = lang
    r = requests.post(f"{SPEECH_URL}/stt",
                      files={"audio": (filename, io.BytesIO(content))},
                      data=data,
                      headers={"x-internal-secret": SECRET} if SECRET else {},
                      timeout=900)
    r.raise_for_status()
    return r.json()


def srt(segments):
    def stamp(t):
        h, rem = divmod(float(t), 3600)
        m, s = divmod(rem, 60)
        return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(s % 1 * 1000):03d}"

    return "\n".join(f"{i}\n{stamp(s['start'])} --> {stamp(s['end'])}\n{s['text'].strip()}\n"
                     for i, s in enumerate(segments, 1))


def handle_audio(msg, chat_id, uid):
    obj, kind = pick_audio(msg)
    if obj["file_size"] and obj["file_size"] > MAX_BYTES:
        send(chat_id, "Файл больше 20 МБ — Telegram не отдаёт такие ботам. "
                      "Пришлите кусок покороче.")
        return
    call("sendChatAction", chat_id=chat_id, action="typing")
    note = send(chat_id, "Распознаю…")
    note_id = ((note.get("result") or {}).get("message_id"))

    started = time.time()
    try:
        content, filename = download(obj["file_id"])
        if not content:
            raise RuntimeError("файл не скачался")
        result = transcribe(content, filename or f"{kind}.ogg", user_lang(uid))
    except Exception as exc:
        log.warning("распознавание не удалось для %s: %s", uid, exc)
        if note_id:
            call("deleteMessage", chat_id=chat_id, message_id=note_id)
        send(chat_id, "Не получилось распознать. Попробуйте ещё раз или пришлите "
                      "другой файл.")
        return

    text = (result.get("text") or "").strip()
    elapsed = time.time() - started
    if note_id:
        call("deleteMessage", chat_id=chat_id, message_id=note_id)

    if not text:
        send(chat_id, "Речь не распознана — возможно, в записи только тишина или шум.")
        return

    log.info("готово: %s, %s, %.1f с, %d символов", uid, user_lang(uid), elapsed, len(text))
    if len(text) <= 3800:
        send(chat_id, text)
    else:
        send_document(chat_id, "transcript.txt", text.encode("utf-8"),
                      caption=f"Текст целиком ({len(text)} символов)")

    segments = result.get("segments") or []
    if len(segments) > 3 and len(text) > 600:
        send_document(chat_id, "subtitles.srt", srt(segments).encode("utf-8"),
                      caption="Субтитры с таймкодами")


def handle_update(upd):
    if "callback_query" in upd:
        cq = upd["callback_query"]
        uid = cq["from"]["id"]
        chat_id = cq["message"]["chat"]["id"]
        data = cq.get("data", "")
        if data.startswith("lang:"):
            code = data.split(":", 1)[1]
            with _lock:
                _state["lang"][str(uid)] = code
                save_state()
            call("answerCallbackQuery", callback_query_id=cq["id"],
                 text=f"Язык: {LANGS.get(code, code)}")
            send(chat_id, f"Язык распознавания: {LANGS.get(code, code)}")
        return

    msg = upd.get("message") or upd.get("channel_post")
    if not msg:
        return
    chat_id = msg["chat"]["id"]
    uid = (msg.get("from") or {}).get("id", chat_id)

    if ALLOWED and uid not in ALLOWED:
        send(chat_id, "Доступ к этому боту ограничен.")
        return

    text = (msg.get("text") or "").strip()
    if text.startswith("/start"):
        send(chat_id, "Здравствуйте! " + HELP)
        return
    if text.startswith("/help"):
        send(chat_id, HELP)
        return
    if text.startswith("/lang"):
        send(chat_id, f"Сейчас: {LANGS.get(user_lang(uid))}. Выберите язык:",
             reply_markup=lang_keyboard())
        return

    obj, _ = pick_audio(msg)
    if not obj:
        if text:
            send(chat_id, "Я работаю со звуком. " + HELP)
        return

    if not rate_ok(uid):
        send(chat_id, f"Слишком много запросов — не больше {RATE_PER_HOUR} в час. "
                      "Попробуйте позже.")
        return

    POOL.submit(handle_audio, msg, chat_id, uid)


def main():
    if not TOKEN:
        raise SystemExit("не задан SPEECH_TELEGRAM_BOT_TOKEN")
    load_state()
    me = call("getMe").get("result") or {}
    log.info("бот @%s запущен, язык по умолчанию %s, доступ: %s",
             me.get("username", "?"), DEFAULT_LANG,
             f"{len(ALLOWED)} разрешённых" if ALLOWED else "открыт всем")
    call("setMyCommands", commands=[
        {"command": "lang", "description": "Язык распознавания"},
        {"command": "help", "description": "Как пользоваться"},
    ])

    offset = None
    while True:
        try:
            r = requests.get(f"{API}/getUpdates",
                             params={"timeout": 30, "offset": offset},
                             timeout=60).json()
        except Exception as exc:
            log.warning("опрос не удался: %s", exc)
            time.sleep(5)
            continue
        for upd in r.get("result", []):
            offset = upd["update_id"] + 1
            try:
                handle_update(upd)
            except Exception:
                log.exception("сбой при обработке сообщения")


POOL = ThreadPoolExecutor(max_workers=2)

if __name__ == "__main__":
    main()
