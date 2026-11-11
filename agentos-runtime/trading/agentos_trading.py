"""AgentOS trading-agent: the XAU_SessionBreakout MT5 Expert Advisor through its file bridge.

The EA makes every trading decision itself (session breakout, built-in time machine,
news filter, risk limits). AgentOS only reads what the EA reports and passes operator
commands to it. Commands are risk-classified like any AgentOS action:

    low    (auto-allowed, they only reduce exposure): pause, signals, risk (down only)
    medium (approval):                                resume, auto, session
    high   (approval):                                close_all

Approved commands run when the approval is approved, unless the approval is older
than `approval_ttl_minutes` (default 30). On a real-money account every command
except pause is refused unless config/trading.json sets "allow_real_account": true.

See sops/trading-gold.md. Standard library only.
"""
from __future__ import annotations

import importlib.util
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent

DEFAULT_CONFIG = {
    "enabled": True,
    "bridge_dir": "",              # ...Common/Files/xau_bridge (or an account subfolder); env XAU_BRIDGE_DIR wins
    "account": "",                 # "<login>_<symbol>" when several EAs share the bridge
    "allow_real_account": False,
    "approval_ttl_minutes": 30,
    "ack_timeout_seconds": 15,
    "stale_after_seconds": 180,
}

# api action -> (AgentOS action name, risk)
ACTIONS = {
    "pause":     ("trading_pause", "low"),
    "signals":   ("trading_mode_signals", "low"),
    "risk":      ("trading_risk_down", "low"),
    "resume":    ("trading_resume", "medium"),
    "auto":      ("trading_mode_auto", "medium"),
    "session":   ("trading_session", "medium"),
    "close_all": ("trading_close_all", "high"),
}
LOW_RISK_ACTIONS = {a for a, r in ACTIONS.values() if r == "low"}
HIGH_RISK_ACTIONS = {a for a, r in ACTIONS.values() if r == "high"}
SESSIONS = {"default", "london", "ny", "asia", "all"}

_BRIDGE = None


def bridge():
    global _BRIDGE
    if _BRIDGE is None:
        spec = importlib.util.spec_from_file_location("agentos_xau_bridge", HERE / "xau_bridge.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _BRIDGE = mod
    return _BRIDGE


def load_config(workspace: Path) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    path = Path(workspace) / "config" / "trading.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            cfg.update({k: v for k, v in raw.items() if k in DEFAULT_CONFIG})
    except (OSError, ValueError):
        pass
    return cfg


def resolve_dir(workspace: Path):
    cfg = load_config(workspace)
    b = bridge()
    saved = {k: os.environ.get(k) for k in ("XAU_BRIDGE_DIR", "XAU_ACCOUNT")}
    try:
        if cfg.get("bridge_dir") and not saved["XAU_BRIDGE_DIR"]:
            os.environ["XAU_BRIDGE_DIR"] = str(cfg["bridge_dir"])
        if cfg.get("account") and not saved["XAU_ACCOUNT"]:
            os.environ["XAU_ACCOUNT"] = str(cfg["account"])
        d = b.bridge_dir(required=False)
    except SystemExit:
        d = None
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return d if d and os.path.isdir(d) else None


def _unavailable(reason: str, cfg: dict) -> dict:
    return {"status": "unavailable", "decision": "trading_status", "error": reason,
            "enabled": bool(cfg.get("enabled")), "secrets_included": False,
            "hint": "Start MT5 with the XAU_SessionBreakout EA (input 'Server bridge' = true) and mount its "
                    "Common/Files/xau_bridge folder into the runtime (XAU_BRIDGE_DIR). See sops/trading-gold.md."}


def status(workspace: Path) -> dict:
    cfg = load_config(workspace)
    if not cfg.get("enabled"):
        return _unavailable("trading_disabled", cfg)
    d = resolve_dir(workspace)
    if not d:
        return _unavailable("bridge_not_found", cfg)
    b = bridge()
    st, age = b.load_status(d)
    if st is None:
        return _unavailable("ea_status_missing", cfg)
    stale = age is None or (age > float(cfg.get("stale_after_seconds") or 180) and not b.market_closed())
    return {
        "status": "ok",
        "decision": "trading_status",
        "agent": "trading-agent",
        "account": os.path.basename(d),
        "account_mode": st.get("account", {}).get("mode"),
        "age_seconds": None if age is None else round(age, 1),
        "stale": bool(stale),
        "ea": st.get("ea", {}),
        "today": st.get("today", {}),
        "positions": st.get("positions", []),
        "sessions": st.get("sessions", []),
        "news_today": st.get("news_today", []),
        "balance": st.get("account", {}).get("balance"),
        "equity": st.get("account", {}).get("equity"),
        "currency": st.get("account", {}).get("currency"),
        "summary_ru": b.fmt_status(st, age),
        "secrets_included": False,
    }


def events(workspace: Path, n: int = 50, kinds=None) -> dict:
    d = resolve_dir(workspace)
    if not d:
        return _unavailable("bridge_not_found", load_config(workspace))
    b = bridge()
    evs, _ = b.read_events(d, 0)
    if kinds:
        evs = [e for e in evs if e.get("kind") in set(kinds)]
    n = max(1, min(int(n or 50), 500))
    evs = evs[-n:]
    return {"status": "ok", "decision": "trading_events", "count": len(evs), "events": evs,
            "lines_ru": [line for line in (b.fmt_event(e, show_skips=True) for e in evs) if line],
            "secrets_included": False}


def report(workspace: Path, days: int = 7) -> dict:
    d = resolve_dir(workspace)
    if not d:
        return _unavailable("bridge_not_found", load_config(workspace))
    b = bridge()
    days = max(1, min(int(days or 7), 90))
    evs, _ = b.read_events(d, 0)
    st, _ = b.load_status(d)
    shift = timedelta(0)
    if st:
        t1, t2 = b.parse_ts(st.get("ts", "")), b.parse_ts(st.get("ts_utc", ""))
        if t1 and t2:
            shift = t1 - t2
    since = b.utcnow() - timedelta(days=days) + shift
    rows = [e for e in evs if (b.parse_ts(e.get("ts", "")) or datetime.min) >= since]
    closes = [e for e in rows if e.get("kind") == "close"]
    by_session = {}
    for e in closes:
        s = by_session.setdefault(e.get("session") or "?", {"trades": 0, "pl": 0.0, "wins": 0})
        s["trades"] += 1
        s["pl"] = round(s["pl"] + float(e.get("pl") or 0), 2)
        s["wins"] += 1 if float(e.get("pl") or 0) > 0 else 0
    pl = round(sum(float(e.get("pl") or 0) for e in closes), 2)
    wins = sum(1 for e in closes if float(e.get("pl") or 0) > 0)
    return {
        "status": "ok", "decision": "trading_report", "days": days,
        "closed_trades": len(closes), "wins": wins, "losses": len(closes) - wins, "pl": pl,
        "by_session": by_session,
        "time_machine": {"taken": sum(1 for e in rows if e.get("kind") == "tm" and e.get("take")),
                         "skipped": sum(1 for e in rows if e.get("kind") == "tm" and not e.get("take"))},
        "news_skips": sum(1 for e in rows if e.get("kind") == "skip" and "news" in (e.get("text") or "")),
        "lines_ru": [b.fmt_event(e) for e in closes[-20:]],
        "secrets_included": False,
    }


def _changes(action: str, value):
    if action == "pause":
        return {"paused": "1"}, None
    if action == "resume":
        return {"paused": "0"}, None
    if action == "signals":
        return {"mode": "signals"}, None
    if action == "auto":
        return {"mode": "auto"}, None
    if action == "risk":
        try:
            v = float(value)
        except (TypeError, ValueError):
            return None, "risk_value_required"
        if not 0 < v <= 5:
            return None, "risk_out_of_range"
        return {"risk_pct": f"{v:g}"}, None
    if action == "session":
        v = str(value or "").lower()
        if v not in SESSIONS:
            return None, "session_invalid"
        return {"session": v}, None
    if action == "close_all":
        return {"close_all": "now"}, None
    return None, "unknown_action"


def execute(workspace: Path, action: str, value=None) -> dict:
    """Write the command for the EA and wait for its acknowledgement."""
    cfg = load_config(workspace)
    changes, err = _changes(action, value)
    if err:
        return {"executed": False, "error": err}
    d = resolve_dir(workspace)
    if not d:
        return {"executed": False, "error": "bridge_not_found"}
    b = bridge()
    st, _ = b.load_status(d)
    login = (st or {}).get("account", {}).get("login")
    seq = b.write_control(d, changes, login)
    ack = b.wait_ack(d, seq, int(cfg.get("ack_timeout_seconds") or 15))
    ea = (ack or {}).get("ea", {})
    return {"executed": True, "seq": seq, "acknowledged": ack is not None,
            "ea_state": {k: ea.get(k) for k in ("mode", "paused", "risk_pct", "session_override", "control_seq")},
            "open_positions": len((ack or {}).get("positions", [])) if ack else None}


def control_request(workspace: Path, action, value, *, request_approval, append_event) -> dict:
    cfg = load_config(workspace)
    action = str(action or "").strip().lower().replace("-", "_")
    if action not in ACTIONS:
        return {"error": "unknown_trading_action", "allowed": sorted(ACTIONS)}
    if not cfg.get("enabled"):
        return {"error": "trading_disabled"}
    _, err = _changes(action, value)
    if err:
        return {"error": err}
    name, risk = ACTIONS[action]
    st = status(workspace)
    if st.get("status") != "ok":
        return {"error": st.get("error", "trading_unavailable"), "hint": st.get("hint")}
    if st.get("account_mode") == "real" and not cfg.get("allow_real_account") and action != "pause":
        append_event(workspace, "trading_control_refused", actor="trading-agent", tool=name, risk=risk,
                     result="real_account_blocked")
        return {"error": "real_account_blocked",
                "detail": "Real-money account: only pause is allowed unless config/trading.json allow_real_account is true."}
    summary = f"Trading: {action}" + (f" {value}" if value not in (None, "") else "") + f" on {st.get('account')}"
    context = {"trading": {"action": action, "value": value, "account": st.get("account"),
                           "requested_at": datetime.now().replace(microsecond=0).isoformat()}}
    if risk == "low":
        result = execute(workspace, action, value)
        append_event(workspace, "trading_control_executed", actor="trading-agent", tool=name, risk=risk,
                     result="acknowledged" if result.get("acknowledged") else "not_acknowledged",
                     seq=result.get("seq"), summary=summary)
        return {"status": "executed", "decision": "auto_allowed", "action": name, "risk": risk, **result}
    gated = request_approval(workspace, name, summary, context=context)
    return {"status": "approval_requested", "action": name, "risk": risk, **gated,
            "will_execute": "only after the approval is approved (expires after "
                            f"{int(cfg.get('approval_ttl_minutes') or 30)} min)"}


def continue_after_gate(workspace: Path, approval: dict, status_value: str, *, append_event):
    ctx = (approval or {}).get("context") or {}
    t = ctx.get("trading")
    if not t or not str(approval.get("action", "")).startswith("trading_"):
        return None
    if status_value != "approved":
        append_event(workspace, "trading_control_denied", actor="trading-agent", tool=approval.get("action"),
                     approval_id=approval.get("id"), result="denied")
        return {"executed": False, "reason": "denied"}
    cfg = load_config(workspace)
    try:
        created = datetime.fromisoformat(str(approval.get("created_at")))
    except ValueError:
        created = None
    ttl = timedelta(minutes=int(cfg.get("approval_ttl_minutes") or 30))
    if created is None or datetime.now() - created > ttl:
        append_event(workspace, "trading_control_expired", actor="trading-agent", tool=approval.get("action"),
                     approval_id=approval.get("id"), result="expired")
        return {"executed": False, "reason": "approval_expired", "detail": "Request it again; trading approvals expire."}
    st = status(workspace)
    if st.get("status") != "ok":
        return {"executed": False, "reason": st.get("error")}
    if t.get("account") and st.get("account") != t.get("account"):
        return {"executed": False, "reason": "account_changed"}
    if st.get("account_mode") == "real" and not cfg.get("allow_real_account") and t.get("action") != "pause":
        return {"executed": False, "reason": "real_account_blocked"}
    result = execute(workspace, t.get("action"), t.get("value"))
    append_event(workspace, "trading_control_executed", actor="trading-agent", tool=approval.get("action"),
                 risk="high" if approval.get("action") in HIGH_RISK_ACTIONS else "medium",
                 approval_id=approval.get("id"),
                 result="acknowledged" if result.get("acknowledged") else "not_acknowledged", seq=result.get("seq"))
    return result
