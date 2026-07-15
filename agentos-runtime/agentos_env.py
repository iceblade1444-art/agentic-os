"""Small stdlib .env loader for AgentOS local credentials.

The loader is intentionally dependency-free and conservative:
- only loads `KEY=value` lines from `<workspace>/.env`;
- supports optional `export KEY=value` syntax and simple quotes;
- never overrides an existing non-empty process environment variable by default;
- skips blank placeholder values so template files do not accidentally count as credentials.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PLACEHOLDER_VALUES = {
    "",
    "<your_key>",
    "<your-key>",
    "<insert_key_here>",
    "<insert-key-here>",
    "your_key_here",
    "your-key-here",
    "changeme",
    "change_me",
    "replace_me",
    "[redacted]",
    "[REDACTED]",
}


def _strip_inline_comment(value: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    for idx, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "'" and not in_double:
            in_single = not in_single
            continue
        if char == '"' and not in_single:
            in_double = not in_double
            continue
        if char == "#" and not in_single and not in_double:
            if idx == 0 or value[idx - 1].isspace():
                return value[:idx].rstrip()
    return value.strip()


def parse_dotenv(path: str | Path) -> dict[str, str]:
    """Parse a dotenv file into key/value pairs without mutating os.environ."""
    dotenv = Path(path)
    if not dotenv.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in dotenv.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not _KEY_RE.match(key):
            continue
        value = _strip_inline_comment(value.strip())
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        value = value.strip()
        if value in _PLACEHOLDER_VALUES or value.lower() in _PLACEHOLDER_VALUES:
            continue
        values[key] = value
    return values


def load_workspace_dotenv(workspace: str | Path, *, override: bool = False) -> dict:
    """Load `<workspace>/.env` into os.environ and return safe metadata only."""
    dotenv = Path(workspace) / ".env"
    values = parse_dotenv(dotenv)
    loaded_keys: list[str] = []
    skipped_existing_keys: list[str] = []
    for key, value in values.items():
        if override or not os.environ.get(key):
            os.environ[key] = value
            loaded_keys.append(key)
        else:
            skipped_existing_keys.append(key)
    return {
        "path": str(dotenv),
        "exists": dotenv.exists(),
        "loaded_keys": loaded_keys,
        "skipped_existing_keys": skipped_existing_keys,
        "available_keys": sorted(values.keys()),
    }
