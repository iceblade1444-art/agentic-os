from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import platform
import sys
from pathlib import Path


def _nova_home() -> Path:
    return Path(os.environ.get("NOVA_VOICE_HOME") or r"C:\NOVA VOICE").expanduser()


def _result(ok: bool, **payload) -> None:
    print(json.dumps({"ok": ok, **payload}, ensure_ascii=False))


def _load_function(module_name: str, function_name: str):
    home = _nova_home()
    if not home.exists():
        raise RuntimeError(f"NOVA_VOICE_HOME not found: {home}")
    sys.path.insert(0, str(home))
    module = importlib.import_module(module_name)
    return getattr(module, function_name)


def _call(module_name: str, function_name: str, params: dict) -> None:
    function = _load_function(module_name, function_name)
    logs = io.StringIO()
    with contextlib.redirect_stdout(logs):
        value = function(params)
    _result(True, value=value, logs=logs.getvalue().strip())


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    params = {}
    if len(sys.argv) > 2:
        params = json.loads(sys.argv[2] or "{}")

    try:
        home = _nova_home()
        if command == "status":
            _result(
                True,
                platform=platform.platform(),
                python=sys.executable,
                novaVoiceHome=str(home),
                novaVoiceReady=home.exists(),
                actionsReady=(home / "actions").exists(),
            )
            return 0
        if command == "computer_control":
            _call("actions.computer_control", "computer_control", params)
            return 0
        if command == "desktop_control":
            _call("actions.desktop", "desktop_control", params)
            return 0
        if command == "screen_process":
            _call("actions.screen_processor", "screen_process", params)
            return 0
        raise RuntimeError(f"Unknown desktop bridge command: {command}")
    except Exception as error:
        _result(False, error=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
