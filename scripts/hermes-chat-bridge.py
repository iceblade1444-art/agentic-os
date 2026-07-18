#!/usr/bin/env python3
"""Local HTTP bridge from Agentic OS to Hermes one-shot chat over a Unix socket."""

from __future__ import annotations

import argparse
import json
import os
import signal
import socketserver
import subprocess
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

MAX_BODY_BYTES = 128 * 1024
MAX_PROMPT_CHARS = 60000
MAX_OUTPUT_CHARS = 200000
DEFAULT_TIMEOUT_SECONDS = 180
RUN_SLOTS = threading.BoundedSemaphore(2)


def bounded(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def compose_prompt(messages: list[dict]) -> str:
    lines = [
        "You are the text assistant inside Agentic OS. Answer the user's latest request directly.",
        "Hermes is the primary orchestrator, but this chat endpoint is conversational and read-only.",
        "You may use read-only web research when useful. Do not run terminal commands, change files,",
        "send external messages, create images, or claim that an external action was completed.",
        "Reply in the language used by the user. Be concise unless the user asks for detail.",
        "",
        "Conversation:",
    ]
    remaining = MAX_PROMPT_CHARS - sum(len(line) + 1 for line in lines)
    clean = []
    for item in messages[-30:]:
        if not isinstance(item, dict):
            continue
        role = bounded(item.get("role"), 20).upper() or "USER"
        content = bounded(item.get("content"), min(12000, max(0, remaining)))
        if not content:
            continue
        clean.append(f"{role}: {content}")
        remaining -= len(clean[-1]) + 1
        if remaining <= 0:
            break
    return "\n".join(lines + clean)[:MAX_PROMPT_CHARS]


def run_hermes(prompt: str, timeout_seconds: int) -> str:
    hermes_bin = os.environ.get(
        "HERMES_BIN", "/home/admilana/.hermes/hermes-agent/venv/bin/hermes"
    )
    workdir = Path(os.environ.get("HERMES_CHAT_WORKDIR", "/tmp/agentic-os-hermes-chat"))
    workdir.mkdir(parents=True, exist_ok=True)
    command = [hermes_bin, "-z", prompt, "--safe-mode", "--toolsets", "safe"]
    process = subprocess.Popen(
        command,
        cwd=workdir,
        env={**os.environ, "HERMES_HOME": os.environ.get("HERMES_HOME", "/home/admilana/.hermes")},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise TimeoutError("Hermes text request timed out")
    if process.returncode != 0:
        detail = bounded(stderr or stdout, 1000) or "Hermes text request failed"
        raise RuntimeError(detail)
    result = bounded(stdout, MAX_OUTPUT_CHARS)
    if not result:
        raise RuntimeError("Hermes returned an empty response")
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "AgenticOSHermesChat/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[hermes-chat] {fmt % args}", flush=True)

    def respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.respond(404, {"error": "not found"})
        self.respond(200, {"ok": True, "provider": "hermes", "mode": "safe"})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            return self.respond(404, {"error": "not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size <= 0 or size > MAX_BODY_BYTES:
            return self.respond(413, {"error": "request body is empty or too large"})
        try:
            payload = json.loads(self.rfile.read(size))
            messages = payload.get("messages") if isinstance(payload, dict) else None
            if not isinstance(messages, list) or not messages:
                return self.respond(400, {"error": "messages are required"})
            if not RUN_SLOTS.acquire(blocking=False):
                return self.respond(429, {"error": "Hermes text provider is busy"})
            try:
                text = run_hermes(
                    compose_prompt(messages),
                    max(30, min(300, int(payload.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS))),
                )
            finally:
                RUN_SLOTS.release()
            self.respond(200, {
                "model": "hermes/openai-codex",
                "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            })
        except TimeoutError as error:
            self.respond(504, {"error": str(error)})
        except (json.JSONDecodeError, ValueError):
            self.respond(400, {"error": "invalid JSON request"})
        except Exception as error:
            self.respond(502, {"error": bounded(error, 1000)})


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", default="/home/admilana/.local/state/agentic-os/hermes-chat.sock")
    args = parser.parse_args()
    socket_path = Path(args.socket)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    server = UnixHTTPServer(str(socket_path), Handler)
    os.chmod(socket_path, 0o660)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
