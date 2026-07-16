#!/usr/bin/env python3
"""Forward a private Unix socket to the loopback-only Hermes Dashboard."""

import asyncio
import os
import signal
import sys
from pathlib import Path


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", 9119)
    except OSError:
        client_writer.close()
        return
    await asyncio.gather(
        pipe(client_reader, upstream_writer),
        pipe(upstream_reader, client_writer),
    )


async def socket_is_live(path: Path) -> bool:
    try:
        _reader, writer = await asyncio.open_unix_connection(path)
        writer.close()
        await writer.wait_closed()
        return True
    except OSError:
        return False


async def main() -> int:
    default_path = os.path.expanduser("~/.local/state/agentic-os/hermes-dashboard.sock")
    socket_path = Path(sys.argv[1] if len(sys.argv) > 1 else default_path)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    if socket_path.exists():
        if await socket_is_live(socket_path):
            return 0
        socket_path.unlink()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    socket_path.chmod(0o600)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    async with server:
        await stop.wait()
    socket_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
