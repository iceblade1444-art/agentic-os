"""WAV to OGG/Opus, because Telegram will not play anything else as a voice.

A Telegram voice message is specifically OGG carrying Opus — hand it a WAV and
it arrives as a file attachment people have to download and open, which is not
a voice message at all. The conversion lives here rather than in the Node API
because ffmpeg is already installed in this image and adding it to another one
would mean maintaining the same dependency twice.

Opus at 24 kbit/s mono is what messengers use for speech: a two-minute morning
brief lands around 350 KB, and the voice is unchanged to the ear.
"""
from __future__ import annotations

import shutil
import subprocess

# Speech, not music: mono, and the bitrate every messenger settled on.
BITRATE = "24k"
CHANNELS = "1"
TIMEOUT_SECONDS = 60


def available() -> bool:
    return shutil.which("ffmpeg") is not None


def wav_to_opus(wav: bytes) -> bytes:
    """Return OGG/Opus bytes for the given WAV.

    Raises RuntimeError rather than returning something unplayable: a caller
    that cannot send a voice message should say so and send text, not send
    silence.
    """
    if not wav:
        raise RuntimeError("no audio to convert")
    if not available():
        raise RuntimeError("ffmpeg is not installed, so speech cannot be packed as a voice message")

    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "wav", "-i", "pipe:0",
            "-c:a", "libopus", "-b:a", BITRATE, "-ac", CHANNELS,
            # Telegram reads the duration from the container; without this the
            # player shows 0:00 and refuses to scrub.
            "-f", "ogg", "pipe:1",
        ],
        input=wav,
        capture_output=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        detail = (result.stderr or b"").decode("utf-8", "replace").strip()[:200]
        raise RuntimeError(f"ffmpeg failed: {detail or 'no output'}")
    return result.stdout
