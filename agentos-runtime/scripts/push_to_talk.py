#!/usr/bin/env python
"""AgentOS push-to-talk/provider wrapper.

This script is the provider boundary for future voice-to-voice systems.
Current safe behavior:
- mock_text/local_file providers produce text;
- text is routed through scripts/voice_command.py;
- Gemini Live is represented as a disabled provider until credentials and exact SDK endpoint are configured.
"""

from __future__ import annotations

import argparse
import json
import importlib.util
import subprocess
import sys
from pathlib import Path

AGENTOS_ROOT = Path(__file__).resolve().parents[1]
if str(AGENTOS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTOS_ROOT))
from agentos_env import load_workspace_dotenv

DEFAULT_WORKSPACE = Path("C:/Users/User/AgentOS")


def deep_merge(base: dict, overlay: dict) -> dict:
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_voice_config(workspace: Path) -> dict:
    load_workspace_dotenv(workspace)
    path = workspace / "config" / "voice.json"
    if not path.exists():
        path = DEFAULT_WORKSPACE / "config" / "voice.json"
    if not path.exists():
        raise FileNotFoundError(f"voice config not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    local_path = workspace / "config" / "voice.local.json"
    if local_path.exists():
        data = deep_merge(data, json.loads(local_path.read_text(encoding="utf-8")))
    return data


def load_provider_module(provider: str):
    module_path = DEFAULT_WORKSPACE / "voice" / "providers" / f"{provider}.py"
    if not module_path.exists():
        raise ValueError(f"provider module not found: {provider}")
    spec = importlib.util.spec_from_file_location(f"agentos_voice_{provider}", module_path)
    module = importlib.util.module_from_spec(spec)
    if spec.loader is None:
        raise RuntimeError(f"cannot load provider module: {provider}")
    spec.loader.exec_module(module)
    return module


def provider_status(config: dict, provider: str) -> dict:
    provider_cfg = config.get("providers", {}).get(provider, {})
    if provider == "gemini_live":
        return load_provider_module(provider).provider_status(provider_cfg)
    return {
        "provider": provider,
        "ready": bool(provider_cfg.get("enabled", True)),
        "enabled": bool(provider_cfg.get("enabled", True)),
        "mode": provider_cfg.get("mode", "unknown"),
    }


def recognized_text_from_provider(workspace: Path, config: dict, provider: str, args) -> str:
    providers = config.get("providers", {})
    if provider not in providers:
        raise ValueError(f"unknown voice provider: {provider}")
    provider_cfg = providers[provider]

    if provider == "mock_text":
        return (args.mock_text or "").strip()

    if provider == "local_file":
        input_file = Path(args.input_file or provider_cfg.get("input_file", workspace / "voice" / "input.txt"))
        return input_file.read_text(encoding="utf-8").strip()

    if provider == "gemini_live":
        return load_provider_module(provider).recognize_once(provider_cfg)

    raise NotImplementedError(f"provider not implemented: {provider}")


def call_voice_command(workspace: Path, text: str, args) -> dict:
    script = workspace / "scripts" / "voice_command.py"
    if not script.exists():
        script = DEFAULT_WORKSPACE / "scripts" / "voice_command.py"
    command = [sys.executable, str(script), "--workspace", str(workspace), "--text", text]
    if args.mock_server:
        command.append("--mock-server")
    if args.tts_command:
        command.extend(["--tts-command", args.tts_command])
    if args.tts_output:
        command.extend(["--tts-output", args.tts_output])
    completed = subprocess.run(command, text=True, capture_output=True, timeout=60)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr or completed.stdout)
    return json.loads(completed.stdout)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="AgentOS push-to-talk voice provider wrapper")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument("--provider", help="Voice provider from config/voice.json")
    parser.add_argument("--mock-text", help="Mock recognized text")
    parser.add_argument("--input-file", help="Read recognized text from file provider")
    parser.add_argument("--mock-server", action="store_true", help="Use direct backend parser instead of HTTP")
    parser.add_argument("--once", action="store_true", help="Run one recognition/action cycle")
    parser.add_argument("--status", action="store_true", help="Print provider readiness status and exit")
    parser.add_argument("--tts-command", help="Optional TTS hook passed through to voice_command.py")
    parser.add_argument("--tts-output", help="Optional TTS output path")
    args = parser.parse_args(argv)

    workspace = Path(args.workspace).expanduser().resolve()
    config = load_voice_config(workspace)
    provider = args.provider or ("mock_text" if args.mock_text else config.get("default_provider", "mock_text"))
    if args.status:
        print(json.dumps(provider_status(config, provider), ensure_ascii=False))
        return 0

    try:
        text = recognized_text_from_provider(workspace, config, provider, args)
        if not text:
            raise RuntimeError("empty recognized voice text")
        voice_result = call_voice_command(workspace, text, args)
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(str(exc), file=sys.stderr)
        return 1

    transcript_dir = workspace / "voice"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    (transcript_dir / "last_provider.txt").write_text(provider + "\n", encoding="utf-8")
    (transcript_dir / "last_transcript.txt").write_text(text + "\n", encoding="utf-8")

    print(json.dumps({"provider": provider, "recognized_text": text, "voice_result": voice_result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
