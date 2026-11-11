#!/usr/bin/env python3
"""
trader-gold: session range breakouts on gold (XAUUSD), long and short.

Three setups, the same rules as the MetaTrader 5 Expert Advisor in mt5/:

  london  London opening range: the first N minutes after 08:00 London time.
  ny      New York opening range: the first N minutes after 08:30 New York time.
  asia    Asian range: 00:00-07:00 London time, traded on the break from 07:00.

Entry: the first completed 5-minute bar after the range that CLOSES above the
range high (buy) or below the range low (sell). One break per session per day:
whichever side breaks first decides, and the session is then done.
Fill: the next bar's open (ask for a buy, bid for a sell).
Stop: the range midpoint (default) or the opposite side of the range.
Target: a multiple of the risk (2R default). Flat at the session's flat time.
Both stop and target touched inside one bar counts as the stop (conservative).

Commands
  backtest   one setup over the data, with every trade's result in R
  compare    every session x stop x target, in-sample vs out-of-sample
  replay     10,000 Monte Carlo reshuffles of a setup's trades at your risk %
  status     today's ranges and breaks, session by session
  setfile    write a .set preset for the EA from a setup
  timemachine  one live signal (paste the EA's push): 10,000 replays of the rest
             of its session from gold's own bars at the same time of day

Data
  --csv FILE         a MetaTrader 5 bar export: either this pack's ExportBars
                     script, or MT5's own Symbols > Bars > Export (tab separated)
  --server-tz eet-us broker server clock: UTC+2, UTC+3 while New York is on
                     daylight time (most MT5 brokers). Or eu:+2 (UTC+2, +3 in
                     EU summer time), fixed:+2, fixed:+3, utc.
  --yahoo            Yahoo Finance GC=F (COMEX gold futures) 5-minute bars,
                     last 60 days. Works where Yahoo is reachable.

Standard library only. Python 3.8+. Time zones are computed from the DST rules
(UK: last Sunday of March/October 01:00 UTC; US: second Sunday of March,
first Sunday of November), exactly like the EA, so no tzdata is needed.

Education and tooling, not financial advice.
"""
import argparse
import bisect
import csv
import io
import json
import math
import os
import random
import sys
import urllib.request
from datetime import datetime, timedelta, date, timezone

H = timedelta(hours=1)
M5 = timedelta(minutes=5)

# ----------------------------------------------------------------- time zones

def nth_sunday(y, m, n):
    first_wd = date(y, m, 1).weekday()          # Mon=0 .. Sun=6
    first_sun = 1 + (6 - first_wd) % 7
    return datetime(y, m, first_sun + 7 * (n - 1))


def last_sunday(y, m):                           # March and October: 31 days
    wd = date(y, m, 31).weekday()
    return datetime(y, m, 31 - (wd + 1) % 7)


def us_dst(utc):
    st = nth_sunday(utc.year, 3, 2) + 7 * H      # 02:00 EST
    en = nth_sunday(utc.year, 11, 1) + 6 * H     # 02:00 EDT
    return st <= utc < en


def uk_dst(utc):
    st = last_sunday(utc.year, 3) + H            # 01:00 UTC
    en = last_sunday(utc.year, 10) + H
    return st <= utc < en


def utc_to_london(u):
    return u + H if uk_dst(u) else u


def london_to_utc(l):
    return l - H if uk_dst(l - H) else l


def utc_to_ny(u):
    return u - 4 * H if us_dst(u) else u - 5 * H


def ny_to_utc(l):
    return l + 4 * H if us_dst(l + 4 * H) else l + 5 * H


class ServerClock:
    """Broker server time <-> UTC."""

    def __init__(self, spec):
        spec = (spec or "eet-us").strip().lower()
        self.spec = spec
        self.eu = None
        if spec == "eet-us":
            self.fixed = None
        elif spec.startswith("eu:"):
            self.fixed = None
            self.eu = float(spec.split(":", 1)[1])        # base offset; +1h in EU/UK summer time
        elif spec == "utc":
            self.fixed = 0
        elif spec.startswith("fixed:"):
            self.fixed = float(spec.split(":", 1)[1])
        else:
            raise SystemExit(f"unknown --server-tz {spec!r}: use eet-us, eu:+2, utc or fixed:+2")

    def to_utc(self, s):
        if self.fixed is not None:
            return s - timedelta(hours=self.fixed)
        if self.eu is not None:
            b = timedelta(hours=self.eu)
            return s - b - H if uk_dst(s - b - H) else s - b
        return s - (3 * H if us_dst(s - 2 * H) else 2 * H)

    def from_utc(self, u):
        if self.fixed is not None:
            return u + timedelta(hours=self.fixed)
        if self.eu is not None:
            return u + timedelta(hours=self.eu) + (H if uk_dst(u) else timedelta(0))
        return u + (3 * H if us_dst(u) else 2 * H)

    def offset_hours_at(self, s):
        return (s - self.to_utc(s)).total_seconds() / 3600.0


def hm(s):
    hh, mm = s.split(":")
    return timedelta(hours=int(hh), minutes=int(mm))

# ----------------------------------------------------------------------- data

class Bars:
    def __init__(self, t, o, h, l, c, sp, clock, meta):
        self.t, self.o, self.h, self.l, self.c, self.sp = t, o, h, l, c, sp
        self.clock = clock
        self.meta = meta

    def __len__(self):
        return len(self.t)

    def idx(self, when):                          # first bar with t >= when
        return bisect.bisect_left(self.t, when)


def _num(x):
    return float(str(x).strip().replace(",", "."))


def load_mt5_csv(path, clock, point_override=None):
    meta = {}
    rows = []
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    if "\x00" in text:                            # UTF-16 export
        with open(path, "r", encoding="utf-16") as f:
            text = f.read()
    lines = [ln for ln in text.splitlines() if ln.strip()]
    body = []
    for ln in lines:
        if ln.startswith("#"):
            k, _, v = ln[1:].strip().partition("=")
            meta[k.strip()] = v.strip()
        else:
            body.append(ln)
    if not body:
        raise SystemExit(f"{path}: no bars")
    head = body[0]
    point = point_override or float(meta.get("point", 0) or 0) or None
    if head.startswith("<DATE>"):                 # MT5 Symbols > Bars > Export
        rdr = csv.reader(body[1:], delimiter="\t")
        cols = [c.strip("<>").upper() for c in head.split("\t")]
        ix = {c: i for i, c in enumerate(cols)}
        for r in rdr:
            if len(r) < 6:
                continue
            ts = datetime.strptime(r[ix["DATE"]] + " " + r[ix["TIME"]][:5], "%Y.%m.%d %H:%M")
            sp = _num(r[ix["SPREAD"]]) if "SPREAD" in ix else 0.0
            rows.append((ts, _num(r[ix["OPEN"]]), _num(r[ix["HIGH"]]), _num(r[ix["LOW"]]),
                         _num(r[ix["CLOSE"]]), sp))
        if point is None:
            # gold quoted with 2 decimals almost everywhere; 3 at a few brokers
            dec = max((len(str(x[4]).split(".")[1]) if "." in str(x[4]) else 0) for x in rows[-200:])
            point = 10 ** -max(dec, 2)
    else:                                         # ExportBars.mq5 / generic CSV
        rdr = csv.DictReader(body, delimiter="," if "," in head else "\t")
        for r in rdr:
            k = {key.strip().lower(): val for key, val in r.items() if key}
            raw = k.get("time") or k.get("datetime") or k.get("date")
            raw = raw.strip()
            ts = None
            for fmt in ("%Y.%m.%d %H:%M", "%Y-%m-%d %H:%M", "%Y.%m.%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
                try:
                    ts = datetime.strptime(raw, fmt)
                    break
                except ValueError:
                    pass
            if ts is None:
                continue
            sp = _num(k.get("spread", 0) or 0)
            rows.append((ts, _num(k["open"]), _num(k["high"]), _num(k["low"]), _num(k["close"]), sp))
        if point is None:
            point = 0.01
    rows.sort(key=lambda x: x[0])
    t = [r[0] for r in rows]
    meta.setdefault("source", os.path.basename(path))
    meta["point_used"] = point
    return Bars(t, [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows],
                [r[4] for r in rows], [r[5] * point for r in rows], clock, meta)


def load_yahoo(symbol, clock):
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}"
           "?interval=5m&range=60d&includePrePost=true")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 trader-gold"})
    with urllib.request.urlopen(req, timeout=30) as r:
        js = json.load(r)
    res = js["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    t, o, h, l, c, sp = [], [], [], [], [], []
    for i, ts in enumerate(res["timestamp"]):
        if None in (q["open"][i], q["high"][i], q["low"][i], q["close"][i]):
            continue
        u = datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None)
        t.append(clock.from_utc(u))
        o.append(q["open"][i]); h.append(q["high"][i]); l.append(q["low"][i]); c.append(q["close"][i])
        sp.append(0.0)
    return Bars(t, o, h, l, c, sp, clock, {"source": f"yahoo {symbol}", "symbol": symbol, "point_used": 0.01})

# ------------------------------------------------------------------ sessions

SESSIONS = ("asia", "london", "ny")          # chronological order inside a day
SESSION_ID = {"london": 0, "ny": 1, "asia": 2}


def session_window(name, local_day, p, clock):
    """Server-time (range_start, range_end, entry_end, flat) for one local date."""
    d = datetime(local_day.year, local_day.month, local_day.day)
    if name == "london":
        conv = london_to_utc
        rs = d + hm(p.london_open); re_ = rs + timedelta(minutes=p.range_min)
        ee = d + hm(p.london_entry_end); fl = d + hm(p.london_flat)
    elif name == "ny":
        conv = ny_to_utc
        rs = d + hm(p.ny_open); re_ = rs + timedelta(minutes=p.range_min)
        ee = d + hm(p.ny_entry_end); fl = d + hm(p.ny_flat)
    else:
        conv = london_to_utc
        rs = d + hm(p.asia_start); re_ = d + hm(p.asia_end)
        ee = d + hm(p.asia_entry_end); fl = d + hm(p.asia_flat)
    return tuple(clock.from_utc(conv(x)) for x in (rs, re_, ee, fl))


def local_days(bars, name):
    clock = bars.clock
    to_local = utc_to_ny if name == "ny" else utc_to_london
    seen = []
    last = None
    for s in bars.t:
        dd = to_local(clock.to_utc(s)).date()
        if dd != last:
            seen.append(dd)
            last = dd
    return sorted(set(seen))


def find_signals(bars, name, p):
    """One candidate trade (or None) per local day: the first break of the range."""
    out = []
    for day in local_days(bars, name):
        if day.weekday() >= 5:
            continue
        rs, re_, ee, fl = session_window(name, day, p, bars.clock)
        i0, i1 = bars.idx(rs), bars.idx(re_)
        n = i1 - i0
        expected = (re_ - rs).total_seconds() / 300.0
        if n < max(1, int(expected * 0.6)):
            continue
        hi = max(bars.h[i0:i1]); lo = min(bars.l[i0:i1])
        rng = hi - lo
        if rng < p.min_range or rng > p.max_range:
            continue
        j = i1
        while j < len(bars) and bars.t[j] < ee:
            c = bars.c[j]
            side = "buy" if c > hi else ("sell" if c < lo else None)
            if side:
                k = j + 1
                if k < len(bars) and bars.t[k] < fl:
                    out.append(dict(session=name, day=str(day), side=side, hi=hi, lo=lo,
                                    signal_time=bars.t[j], k=k, flat=fl))
                break
            j += 1
    return out


def build_trade(bars, sig, p):
    side, hi, lo, k = sig["side"], sig["hi"], sig["lo"], sig["k"]
    if (side == "buy" and not p.allow_long) or (side == "sell" and not p.allow_short):
        return None, "direction off"
    sp = max(bars.sp[k], p.min_spread)
    if sp > p.max_spread:
        return None, "spread"
    bid = bars.o[k]
    mid = (hi + lo) / 2.0
    if side == "buy":
        entry = bid + sp
        stop = mid if p.stop == "mid" else lo
        risk = entry - stop
    else:
        entry = bid
        stop = mid if p.stop == "mid" else hi
        risk = stop - entry
    if risk <= 0 or risk < p.min_stop_spread_mult * sp:
        return None, "stop too tight"
    target = entry + p.target_r * risk if side == "buy" else entry - p.target_r * risk
    # walk forward
    exit_px, exit_t, why = None, None, None
    j = k
    while j < len(bars):
        t = bars.t[j]
        spj = max(bars.sp[j], p.min_spread)
        if t >= sig["flat"]:
            exit_px = bars.o[j] if side == "buy" else bars.o[j] + spj
            exit_t, why = t, "flat"
            break
        o, h, l = bars.o[j], bars.h[j], bars.l[j]
        if side == "buy":
            if o <= stop:  exit_px, why = o, "stop"
            elif o >= target: exit_px, why = o, "target"
            elif l <= stop: exit_px, why = stop, "stop"
            elif h >= target: exit_px, why = target, "target"
        else:
            ao, ah, al = o + spj, h + spj, l + spj
            if ao >= stop: exit_px, why = ao, "stop"
            elif ao <= target: exit_px, why = ao, "target"
            elif ah >= stop: exit_px, why = stop, "stop"
            elif al <= target: exit_px, why = target, "target"
        if why:
            exit_t = t
            break
        j += 1
    if why is None:
        j = len(bars) - 1
        exit_px = bars.c[j] if side == "buy" else bars.c[j] + max(bars.sp[j], p.min_spread)
        exit_t, why = bars.t[j], "end of data"
    r = (exit_px - entry) / risk if side == "buy" else (entry - exit_px) / risk
    return dict(session=sig["session"], day=sig["day"], side=side,
                range_hi=round(hi, 3), range_lo=round(lo, 3),
                entry_time=bars.t[k].strftime("%Y-%m-%d %H:%M"), entry=round(entry, 3),
                stop=round(stop, 3), target=round(target, 3), risk=round(risk, 3),
                exit_time=exit_t.strftime("%Y-%m-%d %H:%M"), exit=round(exit_px, 3),
                exit_reason=why, r=round(r, 4),
                _entry_t=bars.t[k], _exit_t=exit_t), None


def simulate(bars, p):
    names = SESSIONS if p.session == "all" else (p.session,)
    cands = []
    for n in names:
        cands += find_signals(bars, n, p)
    cands.sort(key=lambda s: bars.t[s["k"]])
    trades, skipped = [], {}
    daily_r = p.daily_loss_pct / p.risk_pct
    for sig in cands:
        tr, why = build_trade(bars, sig, p)
        if tr is None:
            skipped[why] = skipped.get(why, 0) + 1
            continue
        et = tr["_entry_t"]
        sday = et.date()                           # broker server day, as in the EA
        today = [x for x in trades if x["_entry_t"].date() == sday]
        if len(today) >= p.max_trades:
            skipped["max trades/day"] = skipped.get("max trades/day", 0) + 1
            continue
        realized = sum(x["r"] for x in trades if x["_exit_t"] <= et and x["_exit_t"].date() == sday)
        open_n = sum(1 for x in trades if x["_entry_t"] <= et < x["_exit_t"])
        used = max(0.0, -realized) + open_n * 1.0
        if used + 1.0 > daily_r + 1e-9:
            skipped["daily loss limit"] = skipped.get("daily loss limit", 0) + 1
            continue
        trades.append(tr)
    return trades, skipped

# --------------------------------------------------------------------- stats

def stats(trades, risk_pct):
    n = len(trades)
    if n == 0:
        return dict(trades=0)
    rs = [t["r"] for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    cum = peak = dd = 0.0
    eq = peak_eq = 1.0
    dd_pct = 0.0
    streak = worst = 0
    for r in rs:
        cum += r; peak = max(peak, cum); dd = max(dd, peak - cum)
        eq *= 1 + r * risk_pct / 100.0; peak_eq = max(peak_eq, eq); dd_pct = max(dd_pct, 1 - eq / peak_eq)
        streak = streak + 1 if r <= 0 else 0; worst = max(worst, streak)
    gl = -sum(losses)
    mean = sum(rs) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in rs) / (n - 1)) if n > 1 else 0.0
    t_stat = mean / (sd / math.sqrt(n)) if sd > 0 else 0.0
    reasons = {}
    for t in trades:
        reasons[t["exit_reason"]] = reasons.get(t["exit_reason"], 0) + 1
    return dict(trades=n, win_rate=round(len(wins) / n * 100, 1), avg_r=round(sum(rs) / n, 3),
                total_r=round(sum(rs), 2),
                profit_factor=round(sum(wins) / gl, 2) if gl > 0 else None,
                max_drawdown_r=round(dd, 2), max_losing_streak=worst,
                return_pct=round((eq - 1) * 100, 2), max_drawdown_pct=round(dd_pct * 100, 2),
                t_stat=round(t_stat, 2), exits=reasons)


def cut_day(bars, frac):
    """Calendar split point, the same for every setup so they are compared on the same periods."""
    return (bars.t[0] + (bars.t[-1] - bars.t[0]) * frac).strftime("%Y-%m-%d")


def split_days(trades, cut):
    return [t for t in trades if t["day"] < cut], [t for t in trades if t["day"] >= cut]

# ---------------------------------------------------------------- reporting

def fmt_stats(s, label=""):
    if not s.get("trades"):
        return f"{label}no trades"
    pf = s["profit_factor"]
    return (f"{label}{s['trades']} trades, win {s['win_rate']}%, avg {s['avg_r']:+.3f}R, "
            f"total {s['total_r']:+.2f}R, PF {pf if pf is not None else '-'}, "
            f"max DD {s['max_drawdown_r']:.2f}R ({s['max_drawdown_pct']:.2f}%), "
            f"return {s['return_pct']:+.2f}%")


def describe(p):
    return (f"{p.session} | stop {p.stop} | target {p.target_r:g}R | range {p.range_min}m | "
            f"{'long+short' if p.allow_long and p.allow_short else ('long' if p.allow_long else 'short')}")


def data_line(bars):
    if not len(bars):
        return "no bars"
    return (f"{bars.meta.get('source')}: {len(bars)} bars, {bars.t[0]:%Y-%m-%d} -> {bars.t[-1]:%Y-%m-%d %H:%M} "
            f"(server time, {bars.clock.spec})")


def out_dir():
    d = os.path.join(os.getcwd(), "trader", "gold")
    os.makedirs(d, exist_ok=True)
    return d


def clean(trades):
    return [{k: v for k, v in t.items() if not k.startswith("_")} for t in trades]

# -------------------------------------------------------------------- params

def add_params(ap):
    g = ap.add_argument_group("setup (defaults = the EA's defaults)")
    g.add_argument("--session", default="london", choices=["london", "ny", "asia", "all"])
    g.add_argument("--stop", default="mid", choices=["mid", "opposite"])
    g.add_argument("--target-r", type=float, default=2.0)
    g.add_argument("--range-min", type=int, default=30)
    g.add_argument("--direction", default="both", choices=["both", "long", "short"])
    g.add_argument("--min-range", type=float, default=1.0, help="skip ranges smaller than this, in USD")
    g.add_argument("--max-range", type=float, default=40.0, help="skip ranges larger than this, in USD")
    g.add_argument("--london-open", default="08:00"); g.add_argument("--london-entry-end", default="12:00")
    g.add_argument("--london-flat", default="16:00")
    g.add_argument("--ny-open", default="08:30"); g.add_argument("--ny-entry-end", default="11:30")
    g.add_argument("--ny-flat", default="16:00")
    g.add_argument("--asia-start", default="00:00"); g.add_argument("--asia-end", default="07:00")
    g.add_argument("--asia-entry-end", default="11:00"); g.add_argument("--asia-flat", default="16:00")
    r = ap.add_argument_group("risk and costs")
    r.add_argument("--risk-pct", type=float, default=0.5)
    r.add_argument("--daily-loss-pct", type=float, default=1.5)
    r.add_argument("--max-trades", type=int, default=3)
    r.add_argument("--min-spread", type=float, default=0.15,
                   help="spread floor in USD when the data's spread is lower or missing")
    r.add_argument("--max-spread", type=float, default=0.50)
    r.add_argument("--min-stop-spread-mult", type=float, default=3.0)
    d = ap.add_argument_group("data")
    d.add_argument("--csv", help="MT5 bar export (M5)")
    d.add_argument("--yahoo", nargs="?", const="GC=F", help="fetch Yahoo 5m bars (default GC=F)")
    d.add_argument("--server-tz", default="eet-us")
    d.add_argument("--point", type=float, help="price of one point, if the export has no header")


def finish(p):
    p.allow_long = p.direction in ("both", "long")
    p.allow_short = p.direction in ("both", "short")
    return p


def load(p):
    clock = ServerClock(p.server_tz)
    if p.csv:
        bars = load_mt5_csv(p.csv, clock, p.point)
        off = bars.meta.get("server_gmt_offset_now_sec")
        if off and len(bars):
            want = int(off) / 3600.0
            got = clock.offset_hours_at(bars.t[-1])
            if abs(want - got) > 0.01:
                print(f"! the broker's clock was UTC{want:+g} at export, but --server-tz {clock.spec} "
                      f"gives UTC{got:+g} for the last bar. Sessions would be shifted. "
                      f"Try --server-tz fixed:{want:+g} or check the broker's time zone.", file=sys.stderr)
    elif p.yahoo:
        bars = load_yahoo(p.yahoo, clock)
    else:
        raise SystemExit("give --csv FILE (MT5 export) or --yahoo")
    if len(bars) < 500:
        print(f"! only {len(bars)} bars; results will be noise", file=sys.stderr)
    return bars

# ------------------------------------------------------------------ commands

def cmd_backtest(p):
    bars = load(p)
    trades, skipped = simulate(bars, p)
    s = stats(trades, p.risk_pct)
    print(data_line(bars))
    print("setup:", describe(p))
    print(fmt_stats(s))
    if skipped:
        print("skipped signals:", ", ".join(f"{k} {v}" for k, v in sorted(skipped.items())))
    if p.session == "all":
        for n in SESSIONS:
            print(fmt_stats(stats([t for t in trades if t["session"] == n], p.risk_pct), f"  {n:7s} "))
    for side in ("buy", "sell"):
        print(fmt_stats(stats([t for t in trades if t["side"] == side], p.risk_pct), f"  {side:7s} "))
    if p.show_trades:
        for t in trades[-p.show_trades:]:
            print(f"  {t['entry_time']} {t['session']:6s} {t['side']:4s} in {t['entry']:.2f} "
                  f"sl {t['stop']:.2f} tp {t['target']:.2f} -> {t['exit_reason']:6s} {t['exit']:.2f} "
                  f"{t['r']:+.2f}R")
    if p.write:
        path = os.path.join(out_dir(), "backtest.json")
        with open(path, "w") as f:
            json.dump(dict(data=data_line(bars), setup=describe(p), params=vars_clean(p),
                           stats=s, skipped=skipped, trades=clean(trades)), f, indent=1, default=str)
        print("wrote", path)


def vars_clean(p):
    return {k: v for k, v in vars(p).items() if k not in ("func", "csv", "yahoo", "write", "show_trades", "out")}


def cmd_compare(p):
    bars = load(p)
    print(data_line(bars))
    cut = cut_day(bars, p.is_frac)
    print(f"in-sample = before {cut} (first {int(p.is_frac*100)}% of the data), out-of-sample = from {cut}. "
          f"Ranked by in-sample avg R (needs >= {p.min_trades} trades).")
    rows = []
    sessions = ["asia", "london", "ny", "all"]
    for sess in sessions:
        for st in ("mid", "opposite"):
            for tr in p.targets:
                q = argparse.Namespace(**vars(p)); q.session, q.stop, q.target_r = sess, st, tr
                trades, _ = simulate(bars, q)
                a, b = split_days(trades, cut)
                rows.append(dict(session=sess, stop=st, target_r=tr,
                                 full=stats(trades, p.risk_pct), ins=stats(a, p.risk_pct),
                                 oos=stats(b, p.risk_pct)))
    ok = [r for r in rows if r["ins"].get("trades", 0) >= p.min_trades]
    ok.sort(key=lambda r: r["ins"]["avg_r"], reverse=True)
    rest = [r for r in rows if r not in ok]
    hdr = f"{'session':7s} {'stop':8s} {'tgt':>4s} | {'IS n':>4s} {'IS avgR':>8s} {'IS totR':>8s} | {'OOS n':>5s} {'OOS avgR':>8s} {'OOS totR':>8s} {'OOS DD':>7s} {'OOS t':>6s}"
    print(hdr); print("-" * len(hdr))
    for r in ok + rest:
        i, o = r["ins"], r["oos"]
        print(f"{r['session']:7s} {r['stop']:8s} {r['target_r']:>4g} | {i.get('trades',0):>4d} "
              f"{i.get('avg_r',0):>+8.3f} {i.get('total_r',0):>+8.2f} | {o.get('trades',0):>5d} "
              f"{o.get('avg_r',0):>+8.3f} {o.get('total_r',0):>+8.2f} {o.get('max_drawdown_r',0):>6.2f}R {o.get('t_stat',0):>6.2f}")
    best = ok[0] if ok else None
    verdict = None
    if best:
        o = best["oos"]
        if not o.get("trades"):
            verdict = "Best in-sample setup has no out-of-sample trades yet. Export more history."
        elif o["avg_r"] <= 0:
            verdict = (f"The best in-sample setup ({best['session']}, {best['stop']}, {best['target_r']:g}R) "
                       f"LOST out of sample ({o['avg_r']:+.3f}R per trade over {o['trades']} trades). "
                       f"No edge survived costs in this data. Do not run it live.")
        elif o["trades"] < 30:
            verdict = (f"Best: {best['session']}, {best['stop']}, {best['target_r']:g}R. Out of sample "
                       f"{o['avg_r']:+.3f}R over only {o['trades']} trades: too few to trust. Demo first.")
        elif o["t_stat"] < 2.0:
            verdict = (f"Best: {best['session']}, {best['stop']}, {best['target_r']:g}R. Out of sample it made "
                       f"{o['avg_r']:+.3f}R per trade over {o['trades']} trades, but t = {o['t_stat']:.2f}: "
                       f"that is inside the range pure luck produces (a random walk does this too, and this "
                       f"setup was picked as the best of {len(rows)}). Not proven. Do not go live on this; "
                       f"export more history and run it again, or demo it for months.")
        else:
            verdict = (f"Best: {best['session']}, {best['stop']}, {best['target_r']:g}R. Held up out of sample: "
                       f"{o['avg_r']:+.3f}R per trade over {o['trades']} trades (t = {o['t_stat']:.2f}), max DD "
                       f"{o['max_drawdown_r']:.2f}R. Confirm in the MT5 Strategy Tester (real ticks), then demo.")
        print("\nverdict:", verdict)
    else:
        print("\nverdict: not enough trades in any setup. Export more history (a year or more of M5).")
    path = os.path.join(out_dir(), "compare.json")
    with open(path, "w") as f:
        json.dump(dict(data=data_line(bars), is_frac=p.is_frac, cut=cut, rows=rows, verdict=verdict,
                       best=(dict(session=best["session"], stop=best["stop"], target_r=best["target_r"])
                             if best else None)), f, indent=1, default=str)
    print("wrote", path)


def cmd_replay(p):
    bars = load(p)
    trades, _ = simulate(bars, p)
    rs = [t["r"] for t in trades]
    print(data_line(bars)); print("setup:", describe(p))
    if len(rs) < 10:
        raise SystemExit(f"only {len(rs)} trades; not enough to replay")
    days = len({t["day"] for t in trades})
    span = max(1, (bars.t[-1] - bars.t[0]).days)
    per_year = int(round(len(rs) * 365.0 / span))
    n = p.trades or per_year
    rnd = random.Random(p.seed)
    finals, dds = [], []
    for _ in range(p.runs):
        eq = peak = 1.0; dd = 0.0
        for _ in range(n):
            eq *= 1 + rnd.choice(rs) * p.risk_pct / 100.0
            peak = max(peak, eq); dd = max(dd, 1 - eq / peak)
        finals.append(eq - 1); dds.append(dd)
    finals.sort(); dds.sort()
    pct = lambda a, q: a[min(len(a) - 1, int(q * len(a)))] * 100
    loss = sum(1 for x in finals if x < 0) / len(finals) * 100
    print(f"{p.runs:,} replays of {n} trades (about one year at this setup's pace), drawn from its "
          f"{len(rs)} real trades, {p.risk_pct}% risk each, seed {p.seed}:")
    print(f"  return: 5th pct {pct(finals,.05):+.1f}%  median {pct(finals,.5):+.1f}%  95th pct {pct(finals,.95):+.1f}%")
    print(f"  max drawdown: median {pct(dds,.5):.1f}%  95th pct {pct(dds,.95):.1f}%")
    print(f"  chance of ending the year down: {loss:.1f}%")
    v = ("more likely down than up: no edge" if loss >= 50 else
         "close to a coin flip" if loss >= 35 else
         "positive in most replays, but the sample decides everything: demo it first")
    print("verdict:", v)
    path = os.path.join(out_dir(), "replay.json")
    with open(path, "w") as f:
        json.dump(dict(setup=describe(p), trades_sample=len(rs), trades_per_run=n, runs=p.runs, seed=p.seed,
                       return_pct=dict(p5=pct(finals, .05), median=pct(finals, .5), p95=pct(finals, .95)),
                       max_dd_pct=dict(median=pct(dds, .5), p95=pct(dds, .95)), chance_down_pct=loss,
                       verdict=v), f, indent=1)
    print("wrote", path)


def cmd_status(p):
    bars = load(p)
    print(data_line(bars))
    last = bars.t[-1]
    for name in SESSIONS:
        to_local = utc_to_ny if name == "ny" else utc_to_london
        day = to_local(bars.clock.to_utc(last)).date()
        rs, re_, ee, fl = session_window(name, day, p, bars.clock)
        line = f"{name:7s} {day}  range {rs:%H:%M}-{re_:%H:%M}  entries until {ee:%H:%M}  flat {fl:%H:%M} (server)  "
        if last < re_:
            print(line + "range not finished"); continue
        i0, i1 = bars.idx(rs), bars.idx(re_)
        if i1 - i0 < 1:
            print(line + "no bars in range"); continue
        hi, lo = max(bars.h[i0:i1]), min(bars.l[i0:i1])
        line += f"hi {hi:.2f} lo {lo:.2f} ({hi-lo:.2f})  "
        brk = None
        j = i1
        while j < len(bars) and bars.t[j] < ee:
            if bars.c[j] > hi: brk = ("BUY", j); break
            if bars.c[j] < lo: brk = ("SELL", j); break
            j += 1
        if brk:
            print(line + f"{brk[0]} break, bar {bars.t[brk[1]]:%H:%M} closed {bars.c[brk[1]]:.2f}")
        elif last >= ee:
            print(line + "no break: done for today")
        else:
            print(line + f"waiting, last {bars.c[-1]:.2f}")


SET_ENUM = {"session": {"london": 0, "ny": 1, "asia": 2, "all": 3}, "stop": {"mid": 0, "opposite": 1}}


def cmd_setfile(p):
    if p.from_compare:
        js = json.load(open(os.path.join(out_dir(), "compare.json")))
        if not js.get("best"):
            raise SystemExit("compare.json has no best setup")
        p.session, p.stop, p.target_r = js["best"]["session"], js["best"]["stop"], js["best"]["target_r"]
    vals = [
        ("InpSession", SET_ENUM["session"][p.session]),
        ("InpRangeMinutes", p.range_min),
        ("InpStopMode", SET_ENUM["stop"][p.stop]),
        ("InpTargetR", p.target_r),
        ("InpAllowLong", "true" if p.allow_long else "false"),
        ("InpAllowShort", "true" if p.allow_short else "false"),
        ("InpMinRangeUSD", p.min_range), ("InpMaxRangeUSD", p.max_range),
        ("InpLondonOpen", p.london_open), ("InpLondonEntryEnd", p.london_entry_end), ("InpLondonFlat", p.london_flat),
        ("InpNYOpen", p.ny_open), ("InpNYEntryEnd", p.ny_entry_end), ("InpNYFlat", p.ny_flat),
        ("InpAsiaStart", p.asia_start), ("InpAsiaEnd", p.asia_end),
        ("InpAsiaEntryEnd", p.asia_entry_end), ("InpAsiaFlat", p.asia_flat),
        ("InpRiskMode", 0), ("InpRiskPercent", p.risk_pct),
        ("InpDailyLossPercent", p.daily_loss_pct), ("InpMaxTradesPerDay", p.max_trades),
        ("InpMaxSpreadUSD", p.max_spread), ("InpMinSpreadUSD", p.min_spread),
        ("InpMinStopSpreadMult", p.min_stop_spread_mult),
    ]
    if p.server_tz == "eet-us":
        vals.append(("InpServerTZ", 0))          # auto: live clock; DST rule in the tester
    elif p.server_tz.startswith("eu:"):
        vals += [("InpServerTZ", 3), ("InpFixedServerOffset", int(float(p.server_tz.split(":")[1])))]
    else:
        off = 0 if p.server_tz == "utc" else int(float(p.server_tz.split(":")[1]))
        vals += [("InpServerTZ", 2), ("InpFixedServerOffset", off)]
    out = p.out or os.path.join(out_dir(), "XAU_SessionBreakout.set")
    text = "; XAU_SessionBreakout preset written by trader-gold (" + describe(p) + ")\r\n"
    text += "".join(f"{k}={v}\r\n" for k, v in vals)
    with open(out, "wb") as f:
        f.write(b"\xff\xfe" + text.encode("utf-16-le"))
    print("wrote", out)
    print("load it in MT5: EA properties > Inputs > Load, or Strategy Tester > Inputs > right-click > Load")


# --------------------------------------------------------------- time machine
#
# One live signal, 10,000 replays of the rest of its session. Each replayed
# 5-minute bar is a real past gold bar from the same local time of day
# (London time for the London and Asia sessions, New York time for NY), plus
# or minus `window` bars, scaled to the current price. Checked bar by bar
# exactly like the backtest: a bar that touches both stop and target is the
# stop; a gap through a level fills at the open; still open at the flat-by
# time = "neither", closed at that price.

import re as _re


def parse_signal(text):
    """Read a pushed EA message (SIGNAL / BOUGHT / SOLD line) into a plan."""
    t = " " + text.replace("\n", " ") + " "
    low = t.lower()
    out = {}
    if "new york" in low or " ny " in low:
        out["session"] = "ny"
    elif "asia" in low:
        out["session"] = "asia"
    elif "london" in low or " ldn " in low:
        out["session"] = "london"
    m = _re.search(r"\b(BUY|SELL|BOUGHT|SOLD)\b", t, _re.I)
    if m:
        out["side"] = "buy" if m.group(1).upper() in ("BUY", "BOUGHT") else "sell"
    m = _re.search(r"(?:\bnow\s*~?\s*|\bat\s+~?\s*)(\d{3,6}(?:\.\d+)?)", t, _re.I)
    if m:
        out["entry"] = float(m.group(1))
    m = _re.search(r"\bSL\s*:?\s*(\d+(?:\.\d+)?)", t, _re.I)
    if m:
        out["stop"] = float(m.group(1))
    m = _re.search(r"\bTP\s*:?\s*(\d+(?:\.\d+)?)", t, _re.I)
    if m:
        out["target"] = float(m.group(1))
    m = _re.search(r"\b(?:close|flat)\s+by\s+(\d{1,2}:\d{2})", t, _re.I)
    if m:
        out["flat"] = m.group(1)
    m = _re.search(r"(\d+(?:\.\d+)?)\s*lots", t, _re.I)
    if m:
        out["lots"] = float(m.group(1))
    return out


def _local(name, clock, s):
    u = clock.to_utc(s)
    return utc_to_ny(u) if name == "ny" else utc_to_london(u)


def _slot(lt):
    return (lt.hour * 60 + lt.minute) // 5


def tm_pool(bars, name, before_day, days):
    """Per local 5-minute slot: (o, h, l, c) / previous close and the spread, from the
    last `days` weekdays before `before_day` (local date). Today is never used."""
    clock = bars.clock
    loc = [_local(name, clock, s) for s in bars.t]
    all_days = sorted({lt.date() for lt in loc if lt.date() < before_day and lt.date().weekday() < 5})
    keep = set(all_days[-days:])
    pool = {}
    for i in range(1, len(bars)):
        d = loc[i].date()
        if d not in keep:
            continue
        if bars.t[i] - bars.t[i - 1] > timedelta(minutes=30):
            continue                                  # no ratios across the daily break or gaps
        pc = bars.c[i - 1]
        if pc <= 0:
            continue
        pool.setdefault(_slot(loc[i]), []).append(
            (bars.o[i] / pc, bars.h[i] / pc, bars.l[i] / pc, bars.c[i] / pc, bars.sp[i]))
    return pool, sorted(keep)


def tm_simulate(pool, slots, side, entry, stop, target, replays=10000, seed=19, window=2, min_spread=0.15):
    rng = random.Random(seed)
    choice = rng.choice
    cand = []
    for s in slots:
        c = []
        for d in range(-window, window + 1):
            c += pool.get(s + d, [])
        cand.append(c)
    buy = side == "buy"
    risk = entry - stop if buy else stop - entry
    p0 = entry - min_spread if buy else entry          # paths are bid prices
    tf = sf = nf = green = 0
    rs, finals = [], []
    for _ in range(replays):
        P = p0
        out = None
        r = 0.0
        sp = min_spread
        for j, cs in enumerate(cand):
            o, h, l, c, sp = choice(cs)
            sp = max(sp, min_spread)
            if j == 0:                                 # the entry bar opens at the fill
                O = P; H = P * h / o; L = P * l / o; C = P * c / o
            else:
                O, H, L, C = P * o, P * h, P * l, P * c
            if out is None:
                if buy:
                    if O <= stop:     out, x = "stop", O
                    elif O >= target: out, x = "target", O
                    elif L <= stop:   out, x = "stop", stop
                    elif H >= target: out, x = "target", target
                else:
                    aO, aH, aL = O + sp, H + sp, L + sp
                    if aO >= stop:     out, x = "stop", aO
                    elif aO <= target: out, x = "target", aO
                    elif aH >= stop:   out, x = "stop", stop
                    elif aL <= target: out, x = "target", target
                if out is not None:
                    r = (x - entry) / risk if buy else (entry - x) / risk
            P = C
        finals.append(P)
        if out is None:
            x = P if buy else P + sp
            r = (x - entry) / risk if buy else (entry - x) / risk
            nf += 1
            if r > 0:
                green += 1
        elif out == "target":
            tf += 1; green += 1
        else:
            sf += 1
        rs.append(r)
    finals.sort()
    q = lambda a, f: a[min(len(a) - 1, int(f * len(a)))]
    n = float(replays)
    return dict(replays=replays, seed=seed, window=window, bars=len(slots),
                target_first=round(tf / n * 100, 1), stop_first=round(sf / n * 100, 1),
                neither=round(nf / n * 100, 1), green=round(green / n * 100, 1),
                avg_r=round(sum(rs) / n, 3),
                flat_price=dict(p5=round(q(finals, .05), 2), median=round(q(finals, .5), 2),
                                p95=round(q(finals, .95), 2)))


def tm_verdict(mc, target_r):
    tf, sf, nf = mc["target_first"], mc["stop_first"], mc["neither"]
    dec = tf + sf
    lines = []
    if dec <= 0:
        return "No replay reached the stop or the target before the flat-by time.", lines
    need = 1.0 / (1.0 + target_r)
    got = tf / dec
    d = (got - need) * 100
    if abs(d) < 5:
        head = "Close to a coin flip" if abs(target_r - 1.0) < 1e-6 else "Close to break-even"
        lean = 0
    elif abs(d) < 15:
        head = "Leans toward the target" if d > 0 else "Leans toward the stop"
        lean = 1 if d > 0 else -1
    else:
        head = "Strongly toward the target" if d > 0 else "Strongly toward the stop"
        lean = 1 if d > 0 else -1
    v = (f"{head}: target first {tf:.1f} % vs stop first {sf:.1f} %. At {target_r:g}R the target must come "
         f"first in {need*100:.0f} % of the replays that hit a side to break even; it did in {got*100:.0f} %.")
    if nf > 40:
        lines.append(f"{nf:.1f} % of the replays hit neither by the flat-by time; the price then decides those.")
    if (lean > 0 and mc["avg_r"] < 0) or (lean < 0 and mc["avg_r"] > 0):
        lines.append(f"Average R {mc['avg_r']:+.3f} points the other way, because of the replays that hit neither.")
    return v, lines


def cmd_timemachine(p):
    sig = parse_signal(p.signal) if p.signal else {}
    name = sig.get("session") or p.session
    if name == "all":
        raise SystemExit("time machine: give one session (--session london|ny|asia) or a signal text")
    side = p.side or sig.get("side")
    entry = p.entry if p.entry is not None else sig.get("entry")
    stop = p.sl if p.sl is not None else sig.get("stop")
    target = p.tp if p.tp is not None else sig.get("target")
    missing = [k for k, v in (("side", side), ("entry", entry), ("stop", stop), ("target", target)) if v is None]
    if missing:
        raise SystemExit("time machine: missing " + ", ".join(missing) +
                         " (paste the EA's SIGNAL/BOUGHT/SOLD push with --signal, or give the flags)")
    buy = side == "buy"
    if buy and not (stop < entry < target):
        raise SystemExit(f"a buy needs stop < entry < target, got {stop} / {entry} / {target}")
    if not buy and not (target < entry < stop):
        raise SystemExit(f"a sell needs target < entry < stop, got {target} / {entry} / {stop}")
    risk = entry - stop if buy else stop - entry
    target_r = round((target - entry) / risk if buy else (entry - target) / risk, 2)

    bars = load(p)
    clock = bars.clock
    now_server = clock.from_utc(datetime.now(timezone.utc).replace(tzinfo=None))
    if p.entry_time:
        dstr = p.date or now_server.strftime("%Y-%m-%d")
        et = datetime.strptime(f"{dstr} {p.entry_time}", "%Y-%m-%d %H:%M")
    else:
        et = now_server
    et = et.replace(second=0, microsecond=0)
    et -= timedelta(minutes=et.minute % 5)
    lt = _local(name, clock, et)
    day = lt.date()
    _, _, _, flat = session_window(name, day, p, clock)
    if sig.get("flat"):
        hh, mm = sig["flat"].split(":")
        f2 = et.replace(hour=int(hh), minute=int(mm))
        if f2 > et:
            flat = f2
    if flat <= et:
        raise SystemExit(f"the entry time {et:%Y-%m-%d %H:%M} (server) is at or after the flat-by time "
                         f"{flat:%H:%M}: nothing left to replay")
    slots = []
    t = et
    while t < flat:
        slots.append(_slot(_local(name, clock, t)))
        t += M5
    pool, days = tm_pool(bars, name, day, p.days)
    thin = [s for s in slots if sum(len(pool.get(s + d, [])) for d in range(-p.window, p.window + 1)) < 15]
    if len(days) < 20 or thin:
        raise SystemExit(f"not enough history: {len(days)} past days in the data "
                         f"({'some time slots have under 15 bars' if thin else 'need 20'}). "
                         f"Export more M5 bars from MT5 (ExportBars) or check the date.")
    if bars.t[-1].date() < day - timedelta(days=7):
        print(f"! the newest bar in the data is {bars.t[-1]:%Y-%m-%d}: the replays use those older days. "
              f"Refresh the export for an up-to-date pool.", file=sys.stderr)

    mc = tm_simulate(pool, slots, side, entry, stop, target, p.replays, p.seed, p.window, p.min_spread)
    verdict, notes = tm_verdict(mc, target_r)

    # the real record of the same rule on those same days
    q = argparse.Namespace(**vars(p)); q.session = name; q.target_r = target_r
    trades, _ = simulate(bars, q)
    dayset = {str(d) for d in days}
    hist = [x for x in trades if x["day"] in dayset]
    h = dict(sessions=len(days), fired=len(hist),
             target=sum(1 for x in hist if x["exit_reason"] == "target"),
             stop=sum(1 for x in hist if x["exit_reason"] == "stop"),
             neither=sum(1 for x in hist if x["exit_reason"] not in ("target", "stop")),
             avg_r=round(sum(x["r"] for x in hist) / len(hist), 3) if hist else None)

    label = {"london": "London ORB", "ny": "New York ORB", "asia": "Asia->London"}[name]
    print(data_line(bars))
    print(f"{label} {side.upper()} {entry:.2f}, stop {stop:.2f}, target {target:.2f} ({target_r:g}R, risk {risk:.2f})")
    print(f"{mc['replays']:,} replays of the rest of the session, {et:%H:%M} to {flat:%H:%M} server "
          f"({mc['bars']} five-minute bars), seed {mc['seed']}, pool: {len(days)} past days "
          f"{days[0]} to {days[-1]}.")
    print(f"  target first   {mc['target_first']:5.1f} %")
    print(f"  stop first     {mc['stop_first']:5.1f} %")
    print(f"  neither        {mc['neither']:5.1f} %   still open at {flat:%H:%M}, closed there")
    print(f"  green          {mc['green']:5.1f} %   target first, or in profit at {flat:%H:%M}")
    fp = mc["flat_price"]
    print(f"  Price at {flat:%H:%M}: median {fp['median']:.2f}, 90 % of replays between {fp['p5']:.2f} and {fp['p95']:.2f}.")
    print(f"  Average R: {mc['avg_r']:+.3f}")
    if h["fired"]:
        print(f"History: the same rule ({name}, stop {p.stop}, {target_r:g}R) on those {h['sessions']} real days "
              f"fired {h['fired']} times: {h['target']} target, {h['stop']} stop, {h['neither']} neither. "
              f"Average R {h['avg_r']:+.3f}.")
    else:
        print(f"History: the same rule did not fire on those {h['sessions']} days.")
    print(verdict)
    for ln in notes:
        print(ln)
    print("Built from gold's own recent bars, not a prediction. NFP, CPI and Fed days can do things "
          "these days never did.")
    path = os.path.join(out_dir(), "timemachine.json")
    with open(path, "w") as f:
        json.dump(dict(plan=dict(session=name, side=side, entry=entry, stop=stop, target=target, target_r=target_r,
                                 entry_time=et.strftime("%Y-%m-%d %H:%M"), flat=flat.strftime("%Y-%m-%d %H:%M"),
                                 lots=sig.get("lots")),
                       data=data_line(bars), pool_days=[str(d) for d in days], mc=mc, history=h,
                       verdict=verdict, notes=notes), f, indent=1)
    print("wrote", path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Gold session breakouts (XAUUSD): backtest, compare, replay, EA presets")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backtest"); add_params(b)
    b.add_argument("--show-trades", type=int, default=0); b.add_argument("--write", action="store_true")
    b.set_defaults(func=cmd_backtest)
    c = sub.add_parser("compare"); add_params(c)
    c.add_argument("--targets", type=float, nargs="+", default=[1.0, 1.5, 2.0])
    c.add_argument("--is-frac", type=float, default=0.7)
    c.add_argument("--min-trades", type=int, default=20)
    c.set_defaults(func=cmd_compare)
    r = sub.add_parser("replay"); add_params(r)
    r.add_argument("--runs", type=int, default=10000); r.add_argument("--seed", type=int, default=19)
    r.add_argument("--trades", type=int, default=0, help="trades per replay (default: one year's worth)")
    r.set_defaults(func=cmd_replay)
    s = sub.add_parser("status"); add_params(s); s.set_defaults(func=cmd_status)
    f = sub.add_parser("setfile"); add_params(f)
    f.add_argument("--out"); f.add_argument("--from-compare", action="store_true")
    f.set_defaults(func=cmd_setfile)
    t = sub.add_parser("timemachine", help="10,000 replays of the rest of the session for one signal")
    add_params(t)
    t.add_argument("--signal", help="paste the EA's push: 'XAU London ORB SIGNAL: BUY ... | SL ... | TP ...'")
    t.add_argument("--side", choices=["buy", "sell"])
    t.add_argument("--entry", type=float); t.add_argument("--sl", type=float); t.add_argument("--tp", type=float)
    t.add_argument("--entry-time", help="HH:MM broker server time (default: now)")
    t.add_argument("--date", help="YYYY-MM-DD broker server date (default: today)")
    t.add_argument("--replays", type=int, default=10000); t.add_argument("--seed", type=int, default=19)
    t.add_argument("--window", type=int, default=2, help="draw from the same time of day +/- this many bars")
    t.add_argument("--days", type=int, default=60, help="past days in the pool")
    t.set_defaults(func=cmd_timemachine)
    p = ap.parse_args(argv)
    finish(p)
    p.func(p)


if __name__ == "__main__":
    main()
