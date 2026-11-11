#!/usr/bin/env python3
"""
xau_bridge: Hermes <-> XAU_SessionBreakout EA (MetaTrader 5 under Wine on this server).

The EA (v2.10+, input "Server bridge" on) keeps these files in MT5's Common\\Files\\xau_bridge:
  status.json    every 15 s: account, EA state, positions, sessions, today's news
  events.jsonl   one JSON line per event: tm, fill, close, signal, skip, control, notice, start, export
  control.txt    written HERE, read by the EA: seq, paused, mode, risk_pct, session, close_all
  XAUUSD_M5.csv  daily M5 export (input for gold.py)

Commands
  setup                         find the bridge folder, save ~/.hermes/xau_bridge.json
  doctor                        check everything, plain answers
  status [--json]               the EA and the account now (Russian)
  report [--days N]             trades from the event log (Russian)
  events [--n N] [--kinds a,b]  raw recent events
  control pause|resume          stop / allow new entries (open trades keep their SL/TP and flat time)
  control mode auto|signals     trade automatically / signals only
  control risk X                risk % per trade (can only LOWER the EA's own setting)
  control session default|london|ny|asia|all
  control close-all --yes       close every position this EA opened, now
  export-path                   path of the newest M5 export (for gold.py --csv)
  watch                         for a Hermes no-agent cron job: new events + "EA silent" alerts

Standard library only. Education and tooling, not financial advice.
"""
import argparse
import glob
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

HERMES = os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes"))
CONFIG = os.path.join(HERMES, "xau_bridge.json")
STATE = os.path.join(HERMES, "xau_bridge_state.json")

SESS_RU = {"london": "Лондон", "ny": "Нью-Йорк", "asia": "Азия→Лондон"}
SIDE_RU = {"buy": "ПОКУПКА", "sell": "ПРОДАЖА"}
REASON_RU = {"stop loss": "стоп-лосс", "take profit": "тейк-профит", "flat-by time / EA": "время выхода",
             "STOP OUT": "STOP OUT (нехватка маржи)", "closed manually": "вручную", "closed by broker": "брокером"}

# ------------------------------------------------------------------ files

def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def candidates():
    home = os.path.expanduser("~")
    pats = []
    for prefix in (os.environ.get("MT5_PREFIX"), os.path.join(home, ".mt5"), os.path.join(home, ".wine")):
        if prefix:
            pats.append(os.path.join(prefix, "drive_c", "users", "*", "AppData", "Roaming", "MetaQuotes",
                                     "Terminal", "Common", "Files"))
            pats.append(os.path.join(prefix, "drive_c", "users", "*", "Application Data", "MetaQuotes",
                                     "Terminal", "Common", "Files"))
    appdata = os.environ.get("APPDATA")                 # MT5 on Windows
    if appdata:
        pats.append(os.path.join(appdata, "MetaQuotes", "Terminal", "Common", "Files"))
    out = []
    for p in pats:
        out += glob.glob(p)
    return out


def bridge_root():
    """...Common/Files/xau_bridge (the EA keeps one subfolder per account: <login>_<symbol>)."""
    env = os.environ.get("XAU_BRIDGE_DIR")
    if env:
        return env
    cfg = _read_json(CONFIG, {})
    if cfg.get("bridge_dir"):
        return cfg["bridge_dir"]
    found = [os.path.join(c, "xau_bridge") for c in candidates()]
    for d in found:
        if os.path.isdir(d):
            return d
    return found[0] if found else None


def accounts(root):
    """Account folders under the root, newest status first."""
    if not root or not os.path.isdir(root):
        return []
    subs = [os.path.join(root, n) for n in os.listdir(root)
            if os.path.isfile(os.path.join(root, n, "status.json"))]
    return sorted(subs, key=lambda d: os.path.getmtime(os.path.join(d, "status.json")), reverse=True)


def bridge_dir(required=True):
    root = bridge_root()
    if root and os.path.isfile(os.path.join(root, "status.json")):
        return root                                  # a folder that is itself an account folder
    acc = _read_json(CONFIG, {}).get("account") or os.environ.get("XAU_ACCOUNT")
    subs = accounts(root)
    if acc:
        for d in subs:
            if os.path.basename(d) == acc:
                return d
        if required:
            raise SystemExit(f"Счёт {acc} не найден в {root}. Есть: " +
                             ", ".join(os.path.basename(d) for d in subs) if subs else f"Счёт {acc} не найден.")
    if subs:
        return subs[0]
    if required:
        raise SystemExit("Не нашёл файлов советника. Запустите советник с включённым 'Server bridge' "
                         "или укажите путь: xau_bridge.py setup --dir ПУТЬ")
    return None


def parse_ts(s):
    for fmt in ("%Y.%m.%d %H:%M:%S", "%Y.%m.%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except (TypeError, ValueError):
            pass
    return None


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def load_status(d):
    st = _read_json(os.path.join(d, "status.json"), None)
    if st is None:                                   # maybe caught mid-replace: try once more
        time.sleep(0.3)
        st = _read_json(os.path.join(d, "status.json"), None)
    if st is None:
        return None, None
    t = parse_ts(st.get("ts_utc", ""))
    age = (utcnow() - t).total_seconds() if t else None
    return st, age


def read_events(d, offset=0):
    path = os.path.join(d, "events.jsonl")
    try:
        size = os.path.getsize(path)
    except OSError:
        return [], 0
    if size < offset:                 # file was replaced or cut: start over
        offset = 0
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    chunk = data[:end + 1]
    evs = []
    for ln in chunk.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        for enc in ("utf-8-sig", "utf-8", "cp1252"):
            try:
                evs.append(json.loads(ln.decode(enc)))
                break
            except (UnicodeDecodeError, ValueError):
                continue
    return evs, offset + len(chunk)


def market_closed(now_utc=None):
    """Gold weekend break, roughly Fri 22:00 UTC to Sun 22:00 UTC (wide on purpose)."""
    n = now_utc or utcnow()
    wd, h = n.weekday(), n.hour
    return (wd == 4 and h >= 21) or wd == 5 or (wd == 6 and h < 23)

# --------------------------------------------------------------- formatting

def fmt_event(e, show_skips=False):
    k = e.get("kind")
    sess = SESS_RU.get(e.get("session", ""), e.get("session", ""))
    side = SIDE_RU.get(e.get("side", ""), e.get("side", ""))
    t = (e.get("ts") or "")[11:16]
    if k == "tm":
        if e.get("take"):
            return (f"{t} {sess} {side} {e.get('entry', 0):.2f}: time machine — тейк первым {e.get('tp_first', 0):.0f}%, "
                    f"стоп {e.get('sl_first', 0):.0f}%; нужно {e.get('need', 0):.0f}% из сработавших, есть "
                    f"{e.get('got', 0):.0f}% ({e.get('edge', 0):+.1f}). История: {e.get('hist_trades', 0)} сделок, "
                    f"в среднем {e.get('hist_avg_r', 0):+.2f}R. ВХОДИМ.")
        why = e.get("why", "")
        edge = e.get("edge", -100)
        tail = f"перевес {edge:+.1f} пункта, {why}" if e.get("ok") else f"time machine не смогла посчитать: {why}"
        return f"{t} {sess} {side} {e.get('entry', 0):.2f}: ПРОПУСК — {tail}."
    if k == "fill":
        return (f"{t} Открыто: {sess}, {side} {e.get('lots', 0):.2f} лот по {e.get('price', 0):.2f}, "
                f"SL {e.get('sl', 0):.2f}, TP {e.get('tp', 0):.2f}, риск {e.get('risk', 0):.2f}. "
                f"Закрытие не позже {e.get('flat_by', '')} (время сервера).")
    if k == "close":
        why = REASON_RU.get(e.get("reason", ""), e.get("reason", ""))
        return (f"{t} Закрыто ({why}): {sess}, {e.get('lots', 0):.2f} лот по {e.get('price', 0):.2f}, "
                f"результат {e.get('pl', 0):+.2f}.")
    if k == "signal":
        return (f"{t} СИГНАЛ (режим «только сигналы»): {sess}, {side} {e.get('lots', 0):.2f} лот около "
                f"{e.get('entry', 0):.2f}, SL {e.get('sl', 0):.2f}, TP {e.get('tp', 0):.2f}, закрыть до "
                f"{e.get('flat_by', '')}.")
    if k == "skip":
        txt = e.get("text", "")
        important = any(w in txt for w in ("news", "daily limit", "trades today", "PAUSED", "history",
                                           "calendar", "margin", "Algo Trading", "not connected"))
        if show_skips or important:
            return f"{t} Сигнал не взят: {txt}"
        return None
    if k == "control":
        return f"{t} Советник принял команду: {e.get('text', '')}"
    if k == "start":
        return f"{t} Советник запущен: {e.get('text', '')}"
    if k == "notice":
        return f"{t} EA: {e.get('text', '')}"
    return None                                    # export and anything unknown: silent


def fmt_status(st, age):
    if st is None:
        return "status.json нет: советник ещё не запускался с включённым мостом, или путь неверный."
    a, ea, today = st.get("account", {}), st.get("ea", {}), st.get("today", {})
    lines = []
    fresh = "только что" if age is not None and age < 60 else (f"{int(age // 60)} мин назад" if age is not None else "?")
    lines.append(f"Советник XAU {st.get('ea_version', '?')} на {st.get('symbol')}, данные {fresh}.")
    if age is not None and age > 180 and not market_closed():
        lines.append("ВНИМАНИЕ: советник давно не обновлял статус — терминал или советник может быть остановлен.")
    acc = "ДЕМО" if a.get("mode") == "demo" else ("РЕАЛЬНЫЙ" if a.get("mode") == "real" else a.get("mode", "?"))
    lines.append(f"Счёт {a.get('login')} ({acc}, {a.get('server')}): баланс {a.get('balance', 0):.2f}, "
                 f"средства {a.get('equity', 0):.2f} {a.get('currency', '')}.")
    mode = "торгует сам" if ea.get("mode") == "auto" else "только сигналы"
    state = "НА ПАУЗЕ (новые входы выключены)" if ea.get("paused") else "работает"
    lines.append(f"Режим: {mode}, {state}. Риск {ea.get('risk_pct', 0):.2f}% на сделку (максимум в настройках "
                 f"{ea.get('risk_pct_max', 0):.2f}%). Сессии: {ea.get('session_override')}. "
                 f"Time machine: {ea.get('time_machine')} (порог {ea.get('tm_min_edge', 0):.1f}). "
                 f"Новостной фильтр: {ea.get('news')}.")
    probs = []
    if not ea.get("algo_trading", True):
        probs.append("Algo Trading выключен — сделки не откроются")
    if not ea.get("connected", True):
        probs.append("терминал не подключён к серверу брокера")
    if probs:
        lines.append("Проблемы: " + "; ".join(probs) + ".")
    lines.append(f"Сегодня: сделок {today.get('trades', 0)} из {today.get('max_trades', 0)}, "
                 f"закрыто на {today.get('realized', 0):+.2f}.")
    pos = st.get("positions", [])
    if pos:
        for p in pos:
            lines.append(f"  Открыто: {p.get('session')} {SIDE_RU.get(p.get('side'), p.get('side'))} {p.get('lots', 0):.2f} "
                         f"по {p.get('open', 0):.2f}, SL {p.get('sl', 0):.2f}, TP {p.get('tp', 0):.2f}, "
                         f"сейчас {p.get('profit', 0):+.2f}, закрыть до {p.get('flat_by')}.")
    else:
        lines.append("Открытых позиций нет.")
    for s in st.get("sessions", []):
        if s.get("enabled"):
            lines.append(f"  {s.get('name')}: диапазон {s.get('range')}, входы до {s.get('entry_end')}, "
                         f"выход {s.get('flat')} (сервер) — {s.get('status')}")
    news = st.get("news_today", [])
    if news:
        lines.append("Важные новости сегодня (время сервера): " +
                     ", ".join(f"{n.get('time')} {n.get('name')}" for n in news) + ".")
    return "\n".join(lines)

# ----------------------------------------------------------------- commands

def cmd_setup(a):
    d = a.dir or bridge_root()
    if not d:
        raise SystemExit("Папка MT5 не найдена. Установите MT5 (mt5linux.sh) или укажите --dir.")
    cfg = _read_json(CONFIG, {})
    cfg["bridge_dir"] = d
    if a.account:
        cfg["account"] = a.account
    _write_json(CONFIG, cfg)
    print(f"Сохранил путь к мосту: {d}")
    subs = accounts(d)
    if subs:
        print("Счета советника: " + ", ".join(os.path.basename(x) for x in subs) +
              ("" if a.account else f" (по умолчанию самый свежий: {os.path.basename(subs[0])})"))
    else:
        print("Файлов советника пока нет — их создаст советник при первом запуске (input 'Server bridge' = true).")


def cmd_doctor(a):
    ok = True
    root = bridge_root()
    subs = accounts(root)
    d = bridge_dir(required=False)
    print(f"Папка моста: {root or 'НЕ НАЙДЕНА'}")
    if len(subs) > 1:
        print("Несколько счетов: " + ", ".join(os.path.basename(x) for x in subs) +
              f". Использую {os.path.basename(d)}; выбрать: xau_bridge.py setup --account ИМЯ")
    if not d or not os.path.isdir(d):
        print("  -> Запустите советник на графике XAUUSD с 'Server bridge' = true.")
        return 1
    st, age = load_status(d)
    if st is None:
        print("status.json: нет -> советник не пишет статус (старая версия или мост выключен).")
        return 1
    print(f"status.json: обновлён {int(age or 0)} с назад, версия {st.get('ea_version')}")
    if age and age > 180 and not market_closed():
        print("  -> Статус старый: терминал остановлен или советник снят с графика.")
        ok = False
    mode = st.get("account", {}).get("mode")
    print(f"Счёт: {mode}" + ("  <- РЕАЛЬНЫЕ ДЕНЬГИ" if mode == "real" else ""))
    ea = st.get("ea", {})
    if not ea.get("algo_trading", True):
        print("  -> Algo Trading выключен в терминале."); ok = False
    if not ea.get("connected", True):
        print("  -> Терминал не подключён к брокеру."); ok = False
    exp = newest_export(d)
    print(f"Выгрузка баров: {exp or 'пока нет (появится после 00:10 по серверу)'}")
    print("Всё в порядке." if ok else "Есть проблемы, см. выше.")
    return 0 if ok else 1


def cmd_status(a):
    st, age = load_status(bridge_dir())
    if a.json:
        print(json.dumps(dict(status=st, age_sec=age), ensure_ascii=False, indent=1))
    else:
        print(fmt_status(st, age))


def cmd_events(a):
    evs, _ = read_events(bridge_dir(), 0)
    kinds = set(a.kinds.split(",")) if a.kinds else None
    evs = [e for e in evs if not kinds or e.get("kind") in kinds]
    for e in evs[-a.n:]:
        print(json.dumps(e, ensure_ascii=False))


def cmd_report(a):
    evs, _ = read_events(bridge_dir(), 0)
    since = utcnow() + timedelta(days=-a.days)
    st, _ = load_status(bridge_dir())
    # event ts are server time; compare loosely using the status' server-UTC difference
    shift = timedelta(0)
    if st:
        t1, t2 = parse_ts(st.get("ts", "")), parse_ts(st.get("ts_utc", ""))
        if t1 and t2:
            shift = t1 - t2
    since_srv = since + shift
    rows = [e for e in evs if (parse_ts(e.get("ts", "")) or datetime.min) >= since_srv]
    closes = [e for e in rows if e.get("kind") == "close"]
    takes = [e for e in rows if e.get("kind") == "tm" and e.get("take")]
    skips = [e for e in rows if e.get("kind") == "tm" and not e.get("take")]
    news = [e for e in rows if e.get("kind") == "skip" and "news" in e.get("text", "")]
    pl = sum(e.get("pl", 0) for e in closes)
    wins = sum(1 for e in closes if e.get("pl", 0) > 0)
    print(f"За {a.days} дн.: закрыто сделок {len(closes)}, в плюс {wins}, в минус {len(closes) - wins}, "
          f"итог {pl:+.2f}.")
    print(f"Time machine: пропустила {len(skips)}, разрешила {len(takes)}. Новостной фильтр пропустил {len(news)}.")
    by = {}
    for e in closes:
        k = SESS_RU.get(e.get("session"), e.get("session"))
        n, s = by.get(k, (0, 0.0))
        by[k] = (n + 1, s + e.get("pl", 0))
    for k, (n, s) in by.items():
        print(f"  {k}: {n} сделок, {s:+.2f}")
    for e in closes[-10:]:
        print("  " + (fmt_event(e) or ""))


def read_control(d):
    vals = {}
    try:
        with open(os.path.join(d, "control.txt"), "r", encoding="utf-8", errors="replace") as f:
            for ln in f:
                if "=" in ln and not ln.startswith("#"):
                    k, v = ln.strip().split("=", 1)
                    vals[k.strip()] = v.strip()
    except OSError:
        pass
    return vals


def write_control(d, changes, login=None):
    os.makedirs(d, exist_ok=True)
    vals = read_control(d)
    if login:
        vals["login"] = str(login)
    vals.pop("close_all", None)                     # a close-all is never repeated by later commands
    vals.update(changes)
    seq = str(time.time_ns() // 1_000_000)
    vals["seq"] = seq
    if changes.get("close_all") == "now":
        vals["close_all"] = seq
    text = "# written by xau_bridge.py; the EA applies a new seq once\n" + \
           "".join(f"{k}={v}\n" for k, v in vals.items())
    tmp = os.path.join(d, "control.txt.tmp")
    with open(tmp, "w", encoding="ascii", newline="\r\n") as f:
        f.write(text)
    os.replace(tmp, os.path.join(d, "control.txt"))
    return int(seq)


def wait_ack(d, seq, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, _ = load_status(d)
        if st and int(st.get("ea", {}).get("control_seq", -1)) == seq:
            return st
        time.sleep(1.0)
    return None


def cmd_control(a):
    d = bridge_dir()
    act = a.action
    if act == "pause":
        ch = {"paused": "1"}
    elif act == "resume":
        ch = {"paused": "0"}
    elif act == "mode":
        if a.value not in ("auto", "signals"):
            raise SystemExit("mode: auto или signals")
        ch = {"mode": a.value}
    elif act == "risk":
        try:
            v = float(a.value)
        except (TypeError, ValueError):
            raise SystemExit("risk: число, например 0.3")
        if not 0 < v <= 5:
            raise SystemExit("risk: от 0 до 5 (советник всё равно не поднимет риск выше своей настройки)")
        ch = {"risk_pct": f"{v:g}"}
    elif act == "session":
        if a.value not in ("default", "london", "ny", "asia", "all"):
            raise SystemExit("session: default, london, ny, asia или all")
        ch = {"session": a.value}
    elif act == "close-all":
        if not a.yes:
            raise SystemExit("close-all закрывает все позиции советника по рынку. Повторите с --yes.")
        ch = {"close_all": "now"}
    else:
        raise SystemExit("неизвестная команда")
    st0, _ = load_status(d)
    if st0 and st0.get("account", {}).get("mode") == "real" and act not in ("pause",) and not a.yes:
        raise SystemExit("Это РЕАЛЬНЫЙ счёт. Подтвердите команду флагом --yes.")
    seq = write_control(d, ch, (st0 or {}).get("account", {}).get("login"))
    st = wait_ack(d, seq, a.timeout)
    if st is None:
        print(f"Команда записана (#{seq}), но советник не подтвердил её за {a.timeout} с. "
              f"Проверьте, что терминал и советник запущены (xau_bridge.py doctor).")
        return 1
    ea = st.get("ea", {})
    print(f"Готово (#{seq}). Сейчас: {'пауза' if ea.get('paused') else 'работает'}, режим {ea.get('mode')}, "
          f"риск {ea.get('risk_pct', 0):.2f}%, сессии {ea.get('session_override')}.")
    if act == "close-all":
        print("Позиции советника: " + (str(len(st.get("positions", []))) + " открыто" if st.get("positions") else "все закрыты"))
    return 0


def newest_export(d):
    files = glob.glob(os.path.join(d, "*_M5.csv"))
    return max(files, key=os.path.getmtime) if files else None


def cmd_export_path(a):
    p = newest_export(bridge_dir())
    if not p:
        raise SystemExit("Выгрузки ещё нет: советник пишет её раз в день после 00:10 по серверу.")
    print(p)


def cmd_watch(a):
    """No-agent cron: print only what is new. Empty output = silent tick."""
    d = bridge_dir(required=False)
    state = _read_json(STATE, {})
    out = []
    if not d or not os.path.isdir(d):
        if not state.get("missing_alerted"):
            out.append("XAU мост: папка советника не найдена. Запущен ли MT5 с советником?")
            state["missing_alerted"] = True
        _write_json(STATE, state)
        print("\n".join(out)) if out else None
        return
    state["missing_alerted"] = False
    first_run = "offset" not in state
    evs, off = read_events(d, state.get("offset", 0))
    if first_run:
        evs = []                                    # don't replay history on the first run
    state["offset"] = off
    for e in evs:
        line = fmt_event(e, show_skips=a.show_skips)
        if line:
            out.append(line)
    st, age = load_status(d)
    stale = (st is None) or (age is not None and age > a.stale_min * 60)
    if stale and not market_closed():
        if not state.get("stale_alerted"):
            out.append(f"XAU: советник молчит больше {a.stale_min} мин (status.json не обновляется). "
                       f"Проверьте терминал MT5 на сервере.")
            state["stale_alerted"] = True
    elif not stale and state.get("stale_alerted"):
        out.append("XAU: советник снова на связи.")
        state["stale_alerted"] = False
    _write_json(STATE, state)
    if out:
        print("\n".join(out))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Hermes <-> XAU_SessionBreakout EA bridge")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup"); s.add_argument("--dir"); s.add_argument("--account", help="e.g. 12345678_XAUUSD")
    s.set_defaults(f=cmd_setup)
    s = sub.add_parser("doctor"); s.set_defaults(f=cmd_doctor)
    s = sub.add_parser("status"); s.add_argument("--json", action="store_true"); s.set_defaults(f=cmd_status)
    s = sub.add_parser("events"); s.add_argument("--n", type=int, default=20); s.add_argument("--kinds")
    s.set_defaults(f=cmd_events)
    s = sub.add_parser("report"); s.add_argument("--days", type=int, default=7); s.set_defaults(f=cmd_report)
    s = sub.add_parser("control")
    s.add_argument("action", choices=["pause", "resume", "mode", "risk", "session", "close-all"])
    s.add_argument("value", nargs="?")
    s.add_argument("--yes", action="store_true")
    s.add_argument("--timeout", type=int, default=30)
    s.set_defaults(f=cmd_control)
    s = sub.add_parser("export-path"); s.set_defaults(f=cmd_export_path)
    s = sub.add_parser("watch"); s.add_argument("--show-skips", action="store_true")
    s.add_argument("--stale-min", type=int, default=5); s.set_defaults(f=cmd_watch)
    a = ap.parse_args(argv)
    rc = a.f(a)
    return rc or 0


if __name__ == "__main__":
    sys.exit(main())
