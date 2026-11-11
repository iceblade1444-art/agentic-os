import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dashboard" / "backend" / "app.py"
sys.path.insert(0, str(ROOT / "trading"))
import agentos_trading  # noqa: E402


def call_api(workspace: Path, path: str, method="GET", payload=None, env=None):
    code = (
        "import json, sys; "
        f"sys.path.insert(0, {str(APP.parent)!r}); "
        "from app import handle_api; "
        f"result = handle_api({str(workspace)!r}, {path!r}, method={method!r}, payload={repr(payload or {})}); "
        "print(json.dumps(result, ensure_ascii=False))"
    )
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, env=env, timeout=120)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def ts(dt):
    return dt.strftime("%Y.%m.%d %H:%M:%S")


class FakeEA:
    """Writes status.json and applies control.txt the way the EA's bridge does."""

    def __init__(self, folder: Path, mode="demo"):
        self.dir = folder
        self.dir.mkdir(parents=True, exist_ok=True)
        self.mode = mode
        self.ea = {"mode": "auto", "paused": False, "risk_pct": 0.5, "risk_pct_max": 0.5, "session_override": "default",
                   "control_seq": -1, "time_machine": "gate", "tm_min_edge": 5.0, "news": "ok",
                   "algo_trading": True, "connected": True, "push": False}
        self.positions = [{"ticket": 7, "session": "London ORB", "side": "buy", "lots": 0.1, "open": 2650.2,
                           "sl": 2645.0, "tp": 2660.6, "profit": 5.0, "opened": "2026.10.27 10:35:00", "flat_by": "18:00"}]
        self.closes = 0
        self.stop = False
        self.write()

    def write(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        st = {"ts": ts(now + timedelta(hours=2)), "ts_utc": ts(now), "ea_version": "2.10", "symbol": "XAUUSD",
              "account": {"login": 555, "server": "Demo", "mode": self.mode, "currency": "USD", "balance": 10000.0,
                          "equity": 10005.0, "margin_free": 9000.0},
              "ea": dict(self.ea), "today": {"history_ok": True, "realized": 0.0, "trades": 1, "max_trades": 3},
              "positions": self.positions, "sessions": [], "news_today": [], "export": "", "last": ""}
        tmp = self.dir / "status.json.tmp"
        tmp.write_text(json.dumps(st), encoding="utf-8")
        tmp.replace(self.dir / "status.json")

    def loop(self):
        while not self.stop:
            ctl = self.dir / "control.txt"
            if ctl.exists():
                vals = {}
                for line in ctl.read_text(encoding="ascii").splitlines():
                    line = line.strip()
                    if "=" in line and not line.startswith("#"):
                        k, v = line.split("=", 1)
                        vals[k.strip().lower()] = v.strip().lower()
                seq = int(vals.get("seq", -1))
                if seq != self.ea["control_seq"]:
                    self.ea["control_seq"] = seq
                    if "paused" in vals:
                        self.ea["paused"] = vals["paused"] == "1"
                    if vals.get("mode") in ("auto", "signals"):
                        self.ea["mode"] = vals["mode"]
                    if "risk_pct" in vals:
                        self.ea["risk_pct"] = min(float(vals["risk_pct"]), self.ea["risk_pct_max"])
                    if vals.get("session"):
                        self.ea["session_override"] = vals["session"]
                    if vals.get("close_all"):
                        self.closes += 1
                        self.positions = []
                    self.write()
            time.sleep(0.2)


def setup(tmp_path, monkeypatch, mode="demo"):
    bridge = tmp_path / "bridge" / "xau_bridge"
    ea = FakeEA(bridge / "555_XAUUSD", mode=mode)
    workspace = tmp_path / "ws"
    (workspace / "config").mkdir(parents=True)
    (workspace / "config" / "trading.json").write_text(json.dumps({"ack_timeout_seconds": 8}), encoding="utf-8")
    monkeypatch.setenv("XAU_BRIDGE_DIR", str(bridge))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    thread = threading.Thread(target=ea.loop, daemon=True)
    thread.start()
    return workspace, ea


def events(workspace):
    path = workspace / "logs" / "events.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def test_status_unavailable_without_bridge(tmp_path, monkeypatch):
    monkeypatch.setenv("XAU_BRIDGE_DIR", str(tmp_path / "nothing"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    data = call_api(tmp_path, "/api/trading/status")
    assert data["status"] == "unavailable"
    assert data["error"] == "bridge_not_found"
    assert data["secrets_included"] is False


def test_status_reads_the_ea(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    try:
        data = call_api(workspace, "/api/trading/status")
        assert data["status"] == "ok"
        assert data["account"] == "555_XAUUSD"
        assert data["account_mode"] == "demo"
        assert data["stale"] is False
        assert data["positions"][0]["ticket"] == 7
        assert "ДЕМО" in data["summary_ru"]
    finally:
        ea.stop = True


def test_pause_is_low_risk_and_runs_at_once(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    try:
        data = call_api(workspace, "/api/trading/control", "POST", {"action": "pause"})
        assert data["status"] == "executed"
        assert data["risk"] == "low"
        assert data["acknowledged"] is True
        assert data["ea_state"]["paused"] is True
        assert ea.ea["paused"] is True
        assert any(e["type"] == "trading_control_executed" and e["actor"] == "trading-agent" for e in events(workspace))
        control = (ea.dir / "control.txt").read_bytes()
        assert b"login=555" in control and b"\r\n" in control
    finally:
        ea.stop = True


def test_resume_needs_approval_then_runs_when_approved(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    ea.ea["paused"] = True
    ea.write()
    try:
        data = call_api(workspace, "/api/trading/control", "POST", {"action": "resume"})
        assert data["status"] == "approval_requested"
        approval = data["approval"]
        assert approval["action"] == "trading_resume"
        assert approval["risk"] == "medium"
        time.sleep(0.6)
        assert ea.ea["paused"] is True                       # nothing happened yet
        approved = call_api(workspace, f"/api/approvals/{approval['id']}/approve", "POST", {})
        assert approved["status"] == "approved"
        assert approved["trading_gate_result"]["acknowledged"] is True
        assert ea.ea["paused"] is False
    finally:
        ea.stop = True


def test_close_all_is_high_risk_and_denial_does_nothing(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    try:
        data = call_api(workspace, "/api/trading/control", "POST", {"action": "close_all"})
        assert data["approval"]["risk"] == "high"
        denied = call_api(workspace, f"/api/approvals/{data['approval']['id']}/deny", "POST", {})
        assert denied["trading_gate_result"] == {"executed": False, "reason": "denied"}
        time.sleep(0.6)
        assert ea.closes == 0 and ea.positions
    finally:
        ea.stop = True


def test_expired_trading_approval_does_not_run(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    try:
        data = call_api(workspace, "/api/trading/control", "POST", {"action": "close_all"})
        path = workspace / "approvals" / "approvals.json"
        records = json.loads(path.read_text(encoding="utf-8"))
        records[-1]["created_at"] = (datetime.now() - timedelta(hours=2)).replace(microsecond=0).isoformat()
        path.write_text(json.dumps(records), encoding="utf-8")
        approved = call_api(workspace, f"/api/approvals/{data['approval']['id']}/approve", "POST", {})
        assert approved["trading_gate_result"]["reason"] == "approval_expired"
        time.sleep(0.6)
        assert ea.closes == 0
    finally:
        ea.stop = True


def test_real_account_blocks_everything_but_pause(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch, mode="real")
    try:
        refused = call_api(workspace, "/api/trading/control", "POST", {"action": "signals"})
        assert refused["error"] == "real_account_blocked"
        paused = call_api(workspace, "/api/trading/control", "POST", {"action": "pause"})
        assert paused["status"] == "executed"
    finally:
        ea.stop = True


def test_invalid_requests(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    try:
        assert call_api(workspace, "/api/trading/control", "POST", {"action": "buy"})["error"] == "unknown_trading_action"
        assert call_api(workspace, "/api/trading/control", "POST", {"action": "risk", "value": 9})["error"] == "risk_out_of_range"
        assert call_api(workspace, "/api/trading/control", "POST", {"action": "session", "value": "tokyo"})["error"] == "session_invalid"
    finally:
        ea.stop = True


def test_report_and_events(tmp_path, monkeypatch):
    workspace, ea = setup(tmp_path, monkeypatch)
    try:
        now = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=2)
        lines = [
            {"ts": ts(now), "kind": "tm", "take": True, "session": "london", "side": "buy", "entry": 2650.2,
             "tp_first": 41, "sl_first": 49, "need": 33, "got": 45.6, "edge": 12.6, "hist_trades": 40, "hist_avg_r": 0.05},
            {"ts": ts(now), "kind": "close", "session": "london", "reason": "take profit", "lots": 0.1, "price": 2660.6, "pl": 104.0},
            {"ts": ts(now), "kind": "close", "session": "ny", "reason": "stop loss", "lots": 0.1, "price": 2640.0, "pl": -50.0},
        ]
        (ea.dir / "events.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")
        report = call_api(workspace, "/api/trading/report?days=1")
        assert report["closed_trades"] == 2 and report["wins"] == 1 and report["pl"] == 54.0
        assert report["time_machine"] == {"taken": 1, "skipped": 0}
        ev = call_api(workspace, "/api/trading/events?n=2&kinds=close")
        assert ev["count"] == 2 and "тейк-профит" in ev["lines_ru"][0]
    finally:
        ea.stop = True


def test_risk_classes_match_app_and_registry():
    app_text = APP.read_text(encoding="utf-8")
    for name in agentos_trading.HIGH_RISK_ACTIONS | agentos_trading.LOW_RISK_ACTIONS:
        assert f'"{name}"' in app_text
    tools = {t["name"]: t for t in json.loads((ROOT / "config" / "tool-registry.json").read_text(encoding="utf-8"))["tools"]}
    mapping = {"pause": "trading.control.pause", "signals": "trading.control.signals", "risk": "trading.control.risk_down",
               "resume": "trading.control.resume", "auto": "trading.control.auto", "session": "trading.control.session",
               "close_all": "trading.control.close_all"}
    for action, (_, risk) in agentos_trading.ACTIONS.items():
        assert tools[mapping[action]]["risk"] == risk
        assert tools[mapping[action]]["requires_approval"] is (risk != "low")
