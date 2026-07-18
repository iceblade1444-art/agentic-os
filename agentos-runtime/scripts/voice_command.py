#!/usr/bin/env python
"""AgentOS local voice adapter.

This is the safe foundation for voice control: it accepts recognized text
(or a text file), sends it through the AgentOS command bridge, and writes a
short spoken response. Real microphone/STT can feed this script later.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

AGENTOS_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKSPACE = AGENTOS_ROOT
DEFAULT_SERVER = "http://127.0.0.1:8765"


def read_text_input(args) -> str:
    if args.text is not None:
        return args.text.strip()
    if args.input_file:
        return Path(args.input_file).read_text(encoding="utf-8").strip()
    if not sys.stdin.isatty():
        return sys.stdin.read().strip()
    return ""


def call_mock_server(workspace: Path, text: str) -> dict:
    backend_dir = AGENTOS_ROOT / "dashboard" / "backend"
    sys.path.insert(0, str(backend_dir))
    from app import run_command  # type: ignore

    return run_command(workspace, text)


def call_http_server(server: str, text: str) -> dict:
    payload = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        server.rstrip("/") + "/api/command",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def spoken_response(command_result: dict) -> str:
    intent = command_result.get("intent")
    result = command_result.get("result") or {}
    if intent == "create_goal":
        return f"Готово. Создала цель: {result.get('goal', 'без названия')}."
    if intent == "show_digest":
        return f"Дайджест готов. Проектов: {result.get('projects', 0)}, ожиданий подтверждения: {result.get('pending_approvals', 0)}."
    if intent == "request_approval":
        approval = result.get("approval") or {}
        return f"Запрос подтверждения создан: {approval.get('id', 'без id')}."
    if intent == "kanban_export":
        return "Kanban export создан."
    return "Команда не распознана. Скажи: создай goal, покажи digest, или создай approval."


def write_voice_artifacts(workspace: Path, command_text: str, command_result: dict, response_text: str) -> None:
    voice_dir = workspace / "voice"
    voice_dir.mkdir(parents=True, exist_ok=True)
    (voice_dir / "last_command.txt").write_text(command_text + "\n", encoding="utf-8")
    (voice_dir / "last_response.txt").write_text(response_text + "\n", encoding="utf-8")
    (voice_dir / "last_result.json").write_text(json.dumps(command_result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def quote_cmd_arg(value: str) -> str:
    return subprocess.list2cmdline([value])


def run_tts_hook(command_template: str | None, response_text: str, output_path: str | None, workspace: Path) -> dict | None:
    if not command_template:
        return None
    output = Path(output_path) if output_path else workspace / "voice" / "last_response_audio.txt"
    output.parent.mkdir(parents=True, exist_ok=True)
    command = command_template.replace("{text}", quote_cmd_arg(response_text)).replace("{output}", quote_cmd_arg(str(output)))
    completed = subprocess.run(command, shell=True, text=True, capture_output=True, timeout=60)
    if completed.returncode != 0:
        return {"status": "failed", "returncode": completed.returncode, "output": (completed.stdout or "") + (completed.stderr or ""), "path": str(output)}
    return {"status": "created", "path": str(output), "output": (completed.stdout or "") + (completed.stderr or "")}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Send recognized voice text to AgentOS /api/command")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--text", default=None, help="Recognized text to process")
    parser.add_argument("--input-file", help="Read recognized text from a file")
    parser.add_argument("--mock-server", action="store_true", help="Call backend parser directly instead of HTTP")
    parser.add_argument("--tts-command", help="Optional command template for TTS; supports {text} and {output}")
    parser.add_argument("--tts-output", help="Optional TTS output path")
    args = parser.parse_args(argv)

    workspace = Path(args.workspace).expanduser().resolve()
    text = read_text_input(args)
    if not text:
        print("empty voice command", file=sys.stderr)
        return 2

    try:
        command_result = call_mock_server(workspace, text) if args.mock_server else call_http_server(args.server, text)
    except Exception as exc:  # noqa: BLE001 - surface adapter failures cleanly
        print(f"voice adapter failed: {exc}", file=sys.stderr)
        return 1

    response_text = spoken_response(command_result)
    write_voice_artifacts(workspace, text, command_result, response_text)
    tts_result = run_tts_hook(args.tts_command, response_text, args.tts_output, workspace)
    output = {
        "transport": "mock-server" if args.mock_server else "http",
        "workspace": str(workspace),
        "text": text,
        "command": command_result,
        "spoken_response": response_text,
        "response_file": str(workspace / "voice" / "last_response.txt"),
        "tts": tts_result,
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
