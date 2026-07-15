#!/usr/bin/env python
"""Safe Mila tray scaffold.

This module is intentionally lightweight and secret-free. If pystray is
available it can be extended into a native tray icon; without optional
dependencies it still offers CLI actions for local desktop launchers.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
import webbrowser
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
DASHBOARD_URL = "http://127.0.0.1:8765/"
BACKEND = WORKSPACE / "dashboard" / "backend" / "app.py"


def open_dashboard() -> str:
    webbrowser.open(DASHBOARD_URL)
    return "open_dashboard: ok"


def status() -> dict:
    try:
        with urllib.request.urlopen(DASHBOARD_URL + "api/production-readiness", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {
            "status": "ok",
            "dashboard": "reachable",
            "readiness": data.get("status"),
            "production_ready": (data.get("readiness") or {}).get("production_ready"),
        }
    except Exception as exc:  # pragma: no cover - defensive CLI helper
        return {"status": "offline", "dashboard": "unreachable", "error": str(exc)}


def restart_dashboard() -> str:
    # Scaffold behavior only: start a local dashboard process if the operator
    # explicitly chooses this action. It does not elevate privileges or mutate
    # credentials/config.
    subprocess.Popen(
        [sys.executable, str(BACKEND), "--workspace", str(WORKSPACE), "--port", "8765"],
        cwd=str(WORKSPACE),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    return "restart_dashboard: requested"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mila tray scaffold")
    parser.add_argument("action", choices=["open_dashboard", "status", "restart_dashboard", "quit"], nargs="?", default="status")
    args = parser.parse_args(argv)
    if args.action == "open_dashboard":
        print(open_dashboard())
    elif args.action == "restart_dashboard":
        print(restart_dashboard())
    elif args.action == "quit":
        print("quit: ok")
    else:
        print(json.dumps(status(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
