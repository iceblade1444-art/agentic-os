import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "dashboard" / "backend"
sys.path.insert(0, str(APP_DIR))

from app import resolve_obsidian_vault  # noqa: E402


def test_obsidian_env_vault_path_overrides_local_config(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    config_dir = workspace / "config"
    config_dir.mkdir(parents=True)
    config_path = config_dir / "obsidian.json"
    config_path.write_text(
        json.dumps(
            {
                "vault_path": "C:\\Users\\User\\Documents\\AgentOS Obsidian Vault",
                "agentos_folder": "AgentOS",
                "sync_mode": "manual",
            }
        ),
        encoding="utf-8",
    )

    server_vault = tmp_path / "server-vault"
    monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(server_vault))

    info = resolve_obsidian_vault(workspace, create=True)

    assert Path(info["vault_path"]) == server_vault
    assert info["source"] == "env"
    assert (server_vault / ".obsidian").exists()
    assert (server_vault / "AgentOS").exists()
