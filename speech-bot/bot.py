"""Telegram front end for our speech service.

Voice in, text out — and back again: every transcript comes with buttons that
translate it and speak the translation in our own Uzbek voice, because that
round trip is the point rather than three unrelated commands. Typing plain text
speaks it, which is what someone who opened a speech bot and typed something
expects.

Long polling rather than a webhook: no public route to expose, no certificate to
manage, and it survives a change of domain or proxy.

Synthesis stays on the fast piper voice. The premium engine sounds better but
runs ~13x slower than realtime on this CPU — a minute of waiting per phrase is
not a chat experience.
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

LLM_URL = os.getenv("LLM_COMPLETE_URL", "http://agentic-os:8787/api/llm/complete")
LLM_HEADERS = {"Content-Type": "application/json"}
if os.getenv("LLM_INTERNAL_SECRET"):
    LLM_HEADERS["x-internal-secret"] = os.environ["LLM_INTERNAL_SECRET"]

# empty list = open to everyone; ids here restrict it to a known group
ALLOWED = {int(x) for x in os.getenv("TELEGRAM_ALLOWED_IDS", "").replace(" ", "").split(",") if x}
RATE_PER_HOUR = int(os.getenv("TELEGRAM_RATE_PER_HOUR", "60"))
MAX_BYTES = 20 * 1024 * 1024          # Telegram's getFile ceiling
# Not a per-request limit any more — long text is split and sent as pieces.
# This is the point past which a voice message stops being a voice message.
MAX_TTS_CHARS = 8000

LANGS = {"uz": "O'zbekcha", "ru": "Русский", "en": "English",
         "kk": "Қазақша", "ky": "Кыргызча", "auto": "определять самому"}
# the voice only exists for these three; kk/ky have recognition but no speech
VOICE_LANGS = {"uz": "Uzbek", "ru": "Russian", "en": "English"}
LANG_NAMES_RU = {"uz": "узбекский", "ru": "русский", "en": "английский",
                 "kk": "казахский", "ky": "киргизский"}

# measured on Russian: every one of them reads it cleanly, so the split is by
# timbre rather than by quality. Pitch in Hz from our own measurement.
VOICES = {
    "uncle_fu": "Дядя Фу — низкий мужской",
    "dylan": "Дилан — мужской",
    "ryan": "Райан — мужской",
    "aiden": "Эйден — молодой мужской",
    "serena": "Серена — женский",
    "sohee": "Сохи — женский",
    "eric": "Эрик — высокий",
    "vivian": "Вивиан — женский",
    "ono_anna": "Анна — высокий женский",
}
DEFAULT_VOICE = "vivian"

# what each engine costs, because that is what decides which one to pick
ENGINES = {
    "fast": "Быстрый — доли секунды",
    "quality": "Качественный — около 40 с",
    "emotion": "Эмоциональный — по описанию",
}
SPEEDS = {"0.8": "медленно", "1.0": "обычно", "1.2": "быстро"}

# A reply keyboard survives until replaced, and the previous owner of this bot
# left one behind. Buttons arrive as plain text, so each is mapped to a command
# before the "speak whatever was typed" fallback can read it aloud.
BUTTONS = {
    "⚙️ Настройки": "/settings",
    "🎙 Голос": "/speaker",
    "🌐 Перевести": "/tr",
    "🈯 Язык": "/lang",
    "⚡ Режим": "/engine",
    "❓ Помощь": "/help",
    "📖 Вопросы": "/faq",
}
REPLY_KEYBOARD = {
    "keyboard": [
        [{"text": "⚙️ Настройки"}, {"text": "🎙 Голос"}],
        [{"text": "🈯 Язык"}, {"text": "⚡ Режим"}],
        [{"text": "🌐 Перевести"}, {"text": "📖 Вопросы"}],
        [{"text": "❓ Помощь"}],
    ],
    "resize_keyboard": True,
    "is_persistent": True,
}
DEFAULT_LANG = os.getenv("BOT_DEFAULT_LANG", "uz")

WELCOME = (
    "Здравствуйте! Я превращаю речь в текст и текст в речь.\n\n"
    "🎙 Пришлите голосовое, кружок или аудиофайл — верну текст.\n"
    "✍️ Напишите текст — озвучу живым голосом.\n"
    "🌐 Под каждой расшифровкой будут кнопки: перевести и озвучить перевод.\n\n"
    "Понимаю узбекский, русский, английский, казахский и киргизский.\n\n"
    "Просто пришлите голосовое — остальное подскажу по ходу."
)

FAQ = (
    "❓ Частые вопросы\n\n"
    "На каких языках работает?\n"
    "Распознавание: узбекский, русский, английский, казахский, киргизский. "
    "Озвучка: узбекский, русский, английский — для казахского и киргизского "
    "голоса пока нет. Язык переключается кнопками «Язык» и «Голос».\n\n"
    "Почему иногда озвучка идёт долго?\n"
    "Быстрый режим отвечает за секунду, качественный и эмоциональный считают "
    "дольше — они дают более живое звучание. Режим меняется кнопкой «Режим». "
    "Длинный текст я разобью на части и пришлю по мере готовности.\n\n"
    "Можно выбрать голос?\n"
    "Да, девять голосов — мужские и женские, кнопка «Голос». Они работают "
    "в качественном и эмоциональном режимах для русского и английского. "
    "Узбекский звучит нашим собственным обученным голосом, он один.\n\n"
    "Какой длины файл можно прислать?\n"
    "До 20 МБ — это ограничение самого Telegram, обойти его я не могу. "
    "Длинную запись пришлите частями.\n\n"
    "Что с моими записями?\n"
    "Всё обрабатывается на собственном сервере компании. Ни одна запись "
    "не уходит в чужие сервисы, ключей и подписок нет.\n\n"
    "Почему в тексте бывают ошибки?\n"
    "Распознавание ошибается примерно в 5 словах из 100, чаще всего на именах, "
    "числах и при шуме. Если запись тихая или с фоном, текст будет хуже — "
    "говорите ближе к микрофону.\n\n"
    "Полный список команд — /help"
)

HELP = (
    "Пришлите голосовое — верну текст.\n"
    "Напишите текст — озвучу нашим голосом.\n\n"
    "Под расшифровкой есть кнопки: перевести и озвучить перевод.\n\n"
    "Команды:\n"
    "/settings — все настройки одним экраном\n"
    "/lang — язык распознавания\n"
    "/voice — язык озвучки\n"
    "/speaker — выбрать голос (9 на выбор)\n"
    "/engine — быстрый, качественный, эмоциональный\n"
    "/speed — темп речи\n"
    "/emotion весело и бодро — задать настроение\n"
    "/tr uz Добрый день — перевести и озвучить\n"
    "/help — эта справка"
)

_lock = threading.Lock()
_state = {"lang": {}, "voice": {}, "speaker": {}, "engine": {}, "speed": {}}
_hits = defaultdict(deque)
# last transcript per user, so the buttons under it have something to act on
_last_text = {}


def load_state():
    global _state
    try:
        _state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        _state = {}
    for key in ("lang", "voice", "speaker", "engine", "speed"):
        _state.setdefault(key, {})


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


def voice_lang(uid) -> str:
    """What the bot speaks in; follows the recognition language until changed."""
    lang = _state["voice"].get(str(uid))
    if lang:
        return lang
    heard = user_lang(uid)
    return heard if heard in VOICE_LANGS else "uz"


def setting(uid, key, default):
    return _state.setdefault(key, {}).get(str(uid), default)


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


# Telegram accepts 4096 characters per message. That ceiling is theirs; what
# happens when text reaches it is ours, and dropping the remainder was the wrong
# answer — a translation that stops mid-word still looks like a translation.
TELEGRAM_LIMIT = 4000


def split_message(text, limit=TELEGRAM_LIMIT):
    """Break a long reply between paragraphs, then sentences, then words."""
    text = text.strip()
    if len(text) <= limit:
        return [text]
    parts, rest = [], text
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind("\n\n"), window.rfind("\n"))
        if cut < limit // 2:
            for mark in (". ", "! ", "? ", "… "):
                cut = max(cut, window.rfind(mark) + len(mark) - 1)
        if cut < limit // 2:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = limit - 1
        parts.append(rest[:cut + 1].strip())
        rest = rest[cut + 1:].lstrip()
    if rest.strip():
        parts.append(rest.strip())
    return [part for part in parts if part]


def send(chat_id, text, **extra):
    pieces = split_message(text)
    result = None
    for i, piece in enumerate(pieces, 1):
        # Buttons belong to the finished thought, so they go on the last piece.
        tail = extra if i == len(pieces) else {}
        result = call("sendMessage", chat_id=chat_id, text=piece,
                      disable_web_page_preview=True, **tail)
    return result


def send_document(chat_id, name, content, caption=""):
    try:
        requests.post(f"{API}/sendDocument",
                      data={"chat_id": chat_id, "caption": caption[:1000]},
                      files={"document": (name, io.BytesIO(content))}, timeout=120)
    except Exception as exc:
        log.warning("не удалось отправить файл: %s", exc)


def send_voice(chat_id, wav, caption=""):
    try:
        requests.post(f"{API}/sendVoice",
                      data={"chat_id": chat_id, "caption": caption[:1000]},
                      files={"voice": ("speech.ogg", io.BytesIO(wav))}, timeout=180)
    except Exception as exc:
        log.warning("не удалось отправить голосовое: %s", exc)


# --- speech service ---------------------------------------------------------
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


def synthesize(text, lang, uid=None):
    engine = setting(uid, "engine", "fast") if uid is not None else "fast"
    # our Uzbek voice is piper-only; the quality engine has no Uzbek at all
    if lang == "uz":
        engine = "fast"
    data = {"text": text[:MAX_TTS_CHARS],
            "language": VOICE_LANGS.get(lang, "Uzbek"),
            "engine": engine,
            "speed": setting(uid, "speed", "1.0") if uid is not None else "1.0"}
    if engine in ("quality", "emotion"):
        data["speaker"] = setting(uid, "speaker", DEFAULT_VOICE)
    if engine == "emotion":
        data["instruct"] = setting(uid, "instruct", "дружелюбно и спокойно")
    r = requests.post(f"{SPEECH_URL}/tts", data=data,
                      headers={"x-internal-secret": SECRET} if SECRET else {},
                      timeout=900)
    r.raise_for_status()
    return r.content


# One call stays faithful to roughly 2500 characters. Past that the reply comes
# back short — a summary wearing a translation's clothes — so long text goes in
# sentence-sized pieces and is stitched back together.
TRANSLATE_CHUNK = 1800


def translate_once(text, target):
    prompt = ("Переведи на " + LANG_NAMES_RU.get(target, target) + " язык. "
              "Верни ТОЛЬКО перевод, без пояснений и без кавычек." + "\n\n" + text)
    r = requests.post(LLM_URL, headers=LLM_HEADERS, timeout=300,
                      json={"prompt": prompt, "temperature": 0,
                            "max_tokens": len(text) // 2 + 512})
    r.raise_for_status()
    return (r.json().get("text") or "").strip()


def translate(text, target):
    """Reuses the router that already corrects transcripts — no new dependency."""
    text = text.strip()
    if len(text) <= TRANSLATE_CHUNK:
        return translate_once(text, target)
    return "\n\n".join(translate_once(part, target)
                        for part in split_message(text, TRANSLATE_CHUNK))


# --- keyboards --------------------------------------------------------------
# Measured on this stack, not guessed. Piper: 6000 characters in 29 s. The Qwen
# engines: 150 characters in 143 s — slow because they render twice and keep the
# better take. The cloned voice moved to the graphics card and now costs a
# fraction of what it did on the CPU.
SECONDS_PER_CHAR = {"fast": 0.005, "quality": 0.95, "emotion": 0.95, "premium": 0.15}

# How much text goes into a single synthesis request. For piper this is a
# comfort limit — it could take far more, but pieces let the first audio arrive
# while the rest is still rendering. For the cloned voice it is a quality limit:
# past roughly 400 characters it starts repeating clauses, and a fast wrong
# answer is worse than a slow right one.
ENGINE_CHUNK = {"fast": 3000, "quality": 220, "emotion": 220, "premium": 300}
CHUNK_CHARS = 220          # fallback for an engine we have not measured
WARN_SECONDS = 45


def chunk_limit(engine):
    return ENGINE_CHUNK.get(engine, CHUNK_CHARS)


def split_sentences(text, limit=CHUNK_CHARS):
    """Split on sentence ends, then on commas, and only then mid-phrase."""
    import re

    parts, current = [], ""
    for piece in re.split(r"(?<=[.!?…])\s+", text.strip()):
        if len(current) + len(piece) + 1 <= limit:
            current = f"{current} {piece}".strip()
            continue
        if current:
            parts.append(current)
        while len(piece) > limit:
            cut = piece.rfind(",", 0, limit)
            if cut < limit // 2:
                cut = piece.rfind(" ", 0, limit)
            if cut < limit // 2:
                cut = limit
            parts.append(piece[:cut].strip())
            piece = piece[cut:].strip(" ,")
        current = piece
    if current:
        parts.append(current)
    return [p for p in parts if p]


def estimate_seconds(text, engine):
    return len(text) * SECONDS_PER_CHAR.get(engine, 0.005)


def human_time(seconds):
    if seconds < 60:
        return f"около {int(seconds)} с"
    return f"около {round(seconds / 60)} мин"


def settings_text(uid):
    engine = setting(uid, "engine", "fast")
    lines = [
        "Текущие настройки:",
        "",
        f"Распознавание: {LANGS.get(user_lang(uid), user_lang(uid))}",
        f"Озвучка: {LANGS.get(voice_lang(uid), voice_lang(uid))}",
        f"Режим: {ENGINES.get(engine, engine)}",
    ]
    if voice_lang(uid) == "uz":
        lines.append("Голос: наш узбекский (единственный)")
    elif engine in ("quality", "emotion"):
        lines.append(f"Голос: {VOICES.get(setting(uid, 'speaker', DEFAULT_VOICE))}")
    else:
        lines.append("Голос: выбор доступен в режимах «качественный» и «эмоциональный»")
    lines.append(f"Темп: {SPEEDS.get(setting(uid, 'speed', '1.0'), '1.0')}")
    if engine == "emotion":
        lines.append(f"Настроение: {setting(uid, 'instruct', 'дружелюбно и спокойно')}")
    return "\n".join(lines)


def keyboard(prefix, options, per_row=2):
    row, rows = [], []
    for code, title in options.items():
        row.append({"text": title, "callback_data": prefix + code})
        if len(row) == per_row:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    return {"inline_keyboard": rows}


def after_text_keyboard():
    """What to do with a transcript: speak it, or translate it first."""
    return {"inline_keyboard": [
        [{"text": "Озвучить", "callback_data": "say:"},
         {"text": "Перевести", "callback_data": "trmenu:"}],
    ]}


def translate_menu():
    rows, row = [], []
    for code in ("uz", "ru", "en"):
        row.append({"text": LANGS[code], "callback_data": "tr:" + code})
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


def srt(segments):
    def stamp(t):
        h, rem = divmod(float(t), 3600)
        m, s = divmod(rem, 60)
        return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(s % 1 * 1000):03d}"

    return "\n".join(f"{i}\n{stamp(s['start'])} --> {stamp(s['end'])}\n{s['text'].strip()}\n"
                     for i, s in enumerate(segments, 1))


# --- handlers ---------------------------------------------------------------
def handle_audio(msg, chat_id, uid):
    obj, kind = pick_audio(msg)
    if obj.get("file_size") and obj["file_size"] > MAX_BYTES:
        send(chat_id, "Файл больше 20 МБ — Telegram не отдаёт такие ботам. "
                      "Пришлите кусок покороче.")
        return
    call("sendChatAction", chat_id=chat_id, action="typing")
    note = send(chat_id, "Распознаю…")
    note_id = (note.get("result") or {}).get("message_id")

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
    if note_id:
        call("deleteMessage", chat_id=chat_id, message_id=note_id)

    if not text:
        send(chat_id, "Речь не распознана — возможно, в записи только тишина или шум.")
        return

    log.info("распознано: %s, %s, %.1f с, %d символов",
             uid, user_lang(uid), time.time() - started, len(text))
    _last_text[uid] = text

    if len(text) <= 3800:
        send(chat_id, text, reply_markup=after_text_keyboard())
    else:
        send_document(chat_id, "transcript.txt", text.encode("utf-8"),
                      caption=f"Текст целиком ({len(text)} символов)")

    segments = result.get("segments") or []
    if len(segments) > 3 and len(text) > 600:
        send_document(chat_id, "subtitles.srt", srt(segments).encode("utf-8"),
                      caption="Субтитры с таймкодами")


def handle_tts(chat_id, uid, text, caption=""):
    if len(text) > MAX_TTS_CHARS:
        send(chat_id, f"Слишком длинный текст для озвучки — не больше "
                      f"{MAX_TTS_CHARS} символов.")
        return

    engine = setting(uid, "engine", "fast")
    if voice_lang(uid) == "uz":
        engine = "fast"
    total = estimate_seconds(text, engine)

    # Split when the text exceeds what this engine renders well in one go, not
    # when a stopwatch says so: the cloned voice needs pieces for the sake of
    # the voice itself, however fast the card is.
    limit = chunk_limit(engine)
    chunks = split_sentences(text, limit) if len(text) > limit else [text]
    if total > WARN_SECONDS or len(chunks) > 1:
        send(chat_id, f"Режим «{ENGINES.get(engine, engine)}» — это {human_time(total)}"
                      f"{f', пришлю {len(chunks)} частями' if len(chunks) > 1 else ''}."
                      f"\nБыстрее будет через /engine.")

    started = time.time()
    for i, part in enumerate(chunks, 1):
        call("sendChatAction", chat_id=chat_id, action="record_voice")
        try:
            wav = synthesize(part, voice_lang(uid), uid)
        except Exception as exc:
            log.warning("озвучка не удалась для %s (часть %d): %s", uid, i, exc)
            send(chat_id, f"Не получилось озвучить{f' часть {i}' if len(chunks) > 1 else ''}. "
                          "Попробуйте текст покороче или быстрый режим (/engine).")
            return
        label = caption if len(chunks) == 1 else f"{i} из {len(chunks)}"
        send_voice(chat_id, wav, caption=label)
    log.info("озвучено: %s, %s, %s, %.1f с, %d символов, частей %d",
             uid, voice_lang(uid), engine, time.time() - started, len(text), len(chunks))


def handle_translate(chat_id, uid, text, target, speak=True):
    call("sendChatAction", chat_id=chat_id, action="typing")
    try:
        translated = translate(text, target)
    except Exception as exc:
        log.warning("перевод не удался для %s: %s", uid, exc)
        send(chat_id, "Переводчик сейчас недоступен — попробуйте позже.")
        return
    if not translated:
        send(chat_id, "Перевод не получился.")
        return
    _last_text[uid] = translated
    send(chat_id, translated, reply_markup=after_text_keyboard())
    if speak and target in VOICE_LANGS:
        with _lock:
            _state["voice"][str(uid)] = target
            save_state()
        handle_tts(chat_id, uid, translated)
    elif speak:
        send(chat_id, f"Озвучки для языка «{LANGS.get(target, target)}» пока нет — "
                      "голос есть для узбекского, русского и английского.")


def handle_callback(cq):
    uid = cq["from"]["id"]
    chat_id = cq["message"]["chat"]["id"]
    data = cq.get("data", "")
    call("answerCallbackQuery", callback_query_id=cq["id"])

    if data.startswith("lang:"):
        code = data.split(":", 1)[1]
        with _lock:
            _state["lang"][str(uid)] = code
            save_state()
        send(chat_id, f"Язык распознавания: {LANGS.get(code, code)}")
    elif data.startswith("voice:"):
        code = data.split(":", 1)[1]
        with _lock:
            _state["voice"][str(uid)] = code
            save_state()
        send(chat_id, f"Язык озвучки: {LANGS.get(code, code)}")
    elif data.startswith("spk:"):
        code = data.split(":", 1)[1]
        with _lock:
            _state.setdefault("speaker", {})[str(uid)] = code
            if setting(uid, "engine", "fast") == "fast":
                _state.setdefault("engine", {})[str(uid)] = "quality"
            save_state()
        send(chat_id, f"Голос: {VOICES.get(code, code)}\n"
                      f"Режим переключён на качественный — иначе голос не применится.")
    elif data.startswith("eng:"):
        code = data.split(":", 1)[1]
        with _lock:
            _state.setdefault("engine", {})[str(uid)] = code
            save_state()
        send(chat_id, f"Режим: {ENGINES.get(code, code)}")
    elif data.startswith("spd:"):
        code = data.split(":", 1)[1]
        with _lock:
            _state.setdefault("speed", {})[str(uid)] = code
            save_state()
        send(chat_id, f"Темп: {SPEEDS.get(code, code)}")
    elif data == "say:":
        text = _last_text.get(uid)
        if not text:
            send(chat_id, "Нечего озвучивать — пришлите запись или текст.")
        else:
            POOL.submit(handle_tts, chat_id, uid, text)
    elif data == "trmenu:":
        send(chat_id, "На какой язык перевести?", reply_markup=translate_menu())
    elif data.startswith("tr:"):
        target = data.split(":", 1)[1]
        text = _last_text.get(uid)
        if not text:
            send(chat_id, "Нечего переводить — пришлите запись или текст.")
        else:
            POOL.submit(handle_translate, chat_id, uid, text, target)


def handle_update(upd):
    if "callback_query" in upd:
        cq = upd["callback_query"]
        if ALLOWED and cq["from"]["id"] not in ALLOWED:
            return
        handle_callback(cq)
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
        send(chat_id, WELCOME, reply_markup=REPLY_KEYBOARD)
        return
    if text.startswith("/keyboard"):
        send(chat_id, "Кнопки внизу обновлены.", reply_markup=REPLY_KEYBOARD)
        return
    if text.startswith("/nokeyboard"):
        send(chat_id, "Кнопки убраны.", reply_markup={"remove_keyboard": True})
        return

    # a tapped button is just text; translate it back into a command before the
    # fallback below reads it aloud
    if text in BUTTONS:
        text = BUTTONS[text]
        if text == "/tr":
            send(chat_id, "Пришлите запись или текст, затем нажмите «Перевести» "
                          "под расшифровкой.\nИли сразу: /tr uz Добрый день")
            return
    if text.startswith("/faq"):
        send(chat_id, FAQ)
        return
    if text.startswith("/help"):
        send(chat_id, HELP, reply_markup=REPLY_KEYBOARD)
        return
    if text.startswith("/lang"):
        send(chat_id, f"Сейчас: {LANGS.get(user_lang(uid))}. Язык распознавания:",
             reply_markup=keyboard("lang:", LANGS))
        return
    if text.startswith("/voice"):
        send(chat_id, f"Сейчас: {LANGS.get(voice_lang(uid))}. Язык озвучки:",
             reply_markup=keyboard("voice:", VOICE_LANGS and
                                   {k: LANGS[k] for k in VOICE_LANGS}))
        return
    if text.startswith("/settings"):
        send(chat_id, settings_text(uid))
        return
    if text.startswith("/speaker"):
        if voice_lang(uid) == "uz":
            send(chat_id, "Для узбекского у нас один собственный голос — тот, что "
                          "мы обучили. Выбор голосов работает для русского и "
                          "английского: смените язык через /voice.")
            return
        send(chat_id, "Голос для режимов «качественный» и «эмоциональный»:",
             reply_markup=keyboard("spk:", VOICES, per_row=1))
        return
    if text.startswith("/engine"):
        send(chat_id, f"Сейчас: {ENGINES.get(setting(uid, 'engine', 'fast'))}. Режим:",
             reply_markup=keyboard("eng:", ENGINES, per_row=1))
        return
    if text.startswith("/speed"):
        send(chat_id, f"Сейчас: {SPEEDS.get(setting(uid, 'speed', '1.0'))}. Темп речи:",
             reply_markup=keyboard("spd:", SPEEDS, per_row=3))
        return
    if text.startswith("/emotion"):
        mood = text[len("/emotion"):].strip()
        if not mood:
            send(chat_id, "Опишите настроение словами, например:\n"
                          "/emotion весело и бодро\n"
                          "/emotion спокойно, с сочувствием\n\n"
                          "Работает в режиме «эмоциональный» (/engine).")
            return
        with _lock:
            _state.setdefault("instruct", {})[str(uid)] = mood[:200]
            _state.setdefault("engine", {})[str(uid)] = "emotion"
            save_state()
        send(chat_id, f"Настроение: {mood[:200]}\nРежим переключён на эмоциональный.")
        return
    if text.startswith("/tr"):
        parts = text.split(maxsplit=2)
        if len(parts) < 3:
            send(chat_id, "Так: /tr uz Добрый день, чем могу помочь?\n"
                          "Языки: uz, ru, en, kk, ky")
            return
        target, body = parts[1].lower(), parts[2]
        if target not in LANG_NAMES_RU:
            send(chat_id, f"Не знаю язык «{target}». Доступны: "
                          + ", ".join(LANG_NAMES_RU))
            return
        if not rate_ok(uid):
            send(chat_id, f"Слишком много запросов — не больше {RATE_PER_HOUR} в час.")
            return
        POOL.submit(handle_translate, chat_id, uid, body, target)
        return

    obj, _ = pick_audio(msg)
    if obj:
        if not rate_ok(uid):
            send(chat_id, f"Слишком много запросов — не больше {RATE_PER_HOUR} в час. "
                          "Попробуйте позже.")
            return
        POOL.submit(handle_audio, msg, chat_id, uid)
        return

    if text:
        if text.startswith("/"):
            send(chat_id, "Не знаю такую команду.\n\n" + HELP)
            return
        if not rate_ok(uid):
            send(chat_id, f"Слишком много запросов — не больше {RATE_PER_HOUR} в час.")
            return
        _last_text[uid] = text
        POOL.submit(handle_tts, chat_id, uid, text)


def main():
    global TOKEN, API, FILE_API
    # idle rather than crash-loop: an unconfigured service should say what it
    # needs, not restart every few seconds until someone reads the logs
    while not TOKEN:
        log.warning("нет SPEECH_TELEGRAM_BOT_TOKEN — создайте бота у @BotFather, "
                    "впишите токен в .env и перезапустите сервис. Жду...")
        time.sleep(60)
        TOKEN = os.getenv("SPEECH_TELEGRAM_BOT_TOKEN", "").strip()
        API = f"https://api.telegram.org/bot{TOKEN}"
        FILE_API = f"https://api.telegram.org/file/bot{TOKEN}"

    load_state()
    me = call("getMe").get("result") or {}
    log.info("бот @%s запущен, распознавание %s, доступ: %s",
             me.get("username", "?"), DEFAULT_LANG,
             f"{len(ALLOWED)} разрешённых" if ALLOWED else "открыт всем")
    call("setMyCommands", commands=[
        {"command": "lang", "description": "Язык распознавания"},
        {"command": "voice", "description": "Язык озвучки"},
        {"command": "speaker", "description": "Выбрать голос"},
        {"command": "engine", "description": "Режим синтеза"},
        {"command": "speed", "description": "Темп речи"},
        {"command": "settings", "description": "Все настройки"},
        {"command": "keyboard", "description": "Показать кнопки"},
        {"command": "tr", "description": "Перевести и озвучить"},
        {"command": "faq", "description": "Частые вопросы"},
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
