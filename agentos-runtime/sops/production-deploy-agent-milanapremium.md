# Production deploy runbook: agent.milanapremium.uz

Last updated: 2026-07-15

This file explains how to deploy the full AgentOS product to:

```text
https://agent.milanapremium.uz/
```

The public visual shell must stay based on the GitHub project:

```text
https://github.com/iceblade1444-art/agentic-os
```

This local workspace (`C:\Users\User\AgentOS`) is the deeper Python AgentOS
runtime core. Do not replace the GitHub visual with the Python dashboard at `/`.
The production target is a combined product: GitHub visual frontend + Node
backend + Python AgentOS runtime + Hermes + Obsidian vault.

## Current status

- The domain currently responds with HTTP 200.
- DNS points `agent.milanapremium.uz` to `93.188.83.254`.
- The live page title matches the GitHub visual: `Agentic OS — The Operating System for AI Agents`.
- The GitHub repo `iceblade1444-art/agentic-os` is reachable; latest checked `main` HEAD was `71a11b9b749c48b94e1da8a742e900dca007cd59`.
- This local `C:\Users\User\AgentOS` checkout currently has no Git remote configured.
- SSH access is working through the private address `172.16.10.6` as user `admilana`.
- The deploy key fingerprint is `SHA256:ctpIkSilaZ8zM5pybvvN4c33ht3sWEIzpXFJATNKwlY`.
- Server-side checks show `sshd` is listening on `0.0.0.0:22` and `[::]:22`, UFW allows `22/tcp`, and `ssh.service` is active.
- Server-side logs show `root` is rejected by `AllowUsers`; use `admilana`, not `root`.
- This Codex machine is also on source address `10.100.50.39` and sees the same public IP (`93.188.83.254`), so public-IP SSH may be failing because of internal NAT/hairpin routing or an upstream firewall. Use the server's private IP from `hostname -I` if available.
- The GitHub visual is running from `/home/admilana/agentic-os` in Docker on port `8787`.
- Hermes Agent `v0.18.2` is installed for `admilana`; invoke it through `~/.local/bin/hermes` in non-interactive shells.
- The production Obsidian vault is `/home/admilana/agentic-os/vault`, already mounted into the visual container.

## Deploy decision

Keep the GitHub Agentic OS visual at the root route and run AgentOS runtime as a
private sidecar service:

```text
browser -> https://agent.milanapremium.uz/
        -> nginx/OpenResty
        -> 127.0.0.1:8787 -> GitHub Agentic OS Node app and visual shell

internal/runtime calls
        -> 127.0.0.1:8765 -> Python AgentOS runtime core
```

Keep both app ports bound to `127.0.0.1`. Do not expose `8787` or `8765`
directly to the internet.

Recommended production layout:

```text
/home/admilana/agentic-os/        GitHub repo, visual shell, Node backend, Docker compose
/home/admilana/agentic-os/agentos-runtime/  Python AgentOS runtime in the GitHub repo
/home/admilana/agentic-os/vault/            Shared Obsidian vault
```

Long-term target:

```text
iceblade1444-art/agentic-os
  index.html
  assets/
  server/
  docker-compose.yml
  agentos-runtime/      # imported from C:\Users\User\AgentOS after cleanup
```

That gives one canonical GitHub project and one server checkout.

## What must be installed

### Hermes Agent

Hermes is required for real Hermes profile discovery and real Hermes Kanban
operations. AgentOS calls it through the `hermes` CLI.

Official Linux install path:

```bash
sudo apt update
sudo apt install -y git curl xz-utils
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.bashrc
hermes doctor
hermes setup
hermes profile list
```

Install Hermes while logged in as `admilana`, because the AgentOS runtime
service also runs as `admilana`. If browser automation dependencies are needed,
install them once as an admin:

```bash
sudo npx playwright install-deps chromium
```

If browser automation is not needed on this server:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-browser
```

### Obsidian

The Obsidian desktop app is not required on a headless production server.
Obsidian vaults are folders containing Markdown files and a `.obsidian`
configuration folder.

For production, create a server vault directory:

```bash
sudo mkdir -p /var/lib/agentos/obsidian-vault
sudo chown -R agentos:agentos /var/lib/agentos
```

Then set:

```bash
OBSIDIAN_VAULT_PATH=/app/obsidian-vault
```

Open that folder in the Obsidian desktop app only on a workstation where a human
needs to read and edit the notes. Sync can be added later with Git, Syncthing,
Obsidian Sync, or another file sync layer.

## Required secrets

There are two environments until everything is merged into one GitHub repo.

GitHub Agentic OS visual/backend:

```bash
nano /home/admilana/agentic-os/.env
```

Minimum useful file:

```dotenv
PORT=8787
HOST_PORT=8787
BIND_ADDRESS=127.0.0.1
DATA_DIR=./data
OBSIDIAN_VAULT=./vault
AUTH_TOKEN=replace_with_openssl_rand_hex_32
SESSION_SECRET=replace_with_openssl_rand_hex_32
SECURE_COOKIE=true
AGENTIC_OS_TOKEN=replace_with_same_or_separate_token
ALLOW_CUSTOM_MCP=false
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

Python AgentOS runtime:

```bash
nano /home/admilana/agentos-runtime/.env
```

Minimum useful file:

```dotenv
GEMINI_API_KEY=replace_me
GOOGLE_API_KEY=replace_me
OBSIDIAN_VAULT_PATH=/var/lib/agentos/obsidian-vault
AGENTOS_PORT=8765
```

Optional, only if those providers are enabled later:

```dotenv
OPENAI_API_KEY=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

## First server setup

Assume Ubuntu/Debian and the existing `admilana` user from the screenshot:

```bash
sudo apt update
sudo apt install -y git curl xz-utils nginx python3 python3-venv python3-pip rsync
sudo mkdir -p /var/lib/agentos/obsidian-vault
sudo chown -R admilana:admilana /var/lib/agentos
```

Deploy the GitHub visual first:

```bash
cd /home/admilana
git clone https://github.com/iceblade1444-art/agentic-os.git agentic-os
cd /home/admilana/agentic-os
cp .env.example .env
nano .env
bash deploy.sh
curl -fsS http://127.0.0.1:8787/api/health
```

Copy this Python AgentOS runtime next. Temporary path until it is merged into
the GitHub repo:

```bash
rsync -az --delete \
  --exclude .git \
  --exclude .env \
  --exclude __pycache__ \
  --exclude .pytest_cache \
  --exclude logs/runtime \
  ./ admilana@SERVER:/home/admilana/agentos-runtime/
```

Create a virtual environment:

```bash
cd /home/admilana/agentos-runtime
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install pytest google-genai
```

`google-genai` is needed for Gemini Native Audio voice. If voice is disabled,
the dashboard can still run without it, but the native voice endpoint will not
be ready.

## Preflight checks

Run these before touching nginx:

```bash
cd /home/admilana/agentos-runtime
.venv/bin/python agentosctl.py release check --pretty
.venv/bin/python -m pytest -q
env OBSIDIAN_VAULT_PATH=/var/lib/agentos/obsidian-vault \
  .venv/bin/python dashboard/backend/app.py \
  --workspace /home/admilana/agentos-runtime \
  --host 127.0.0.1 \
  --port 8765
```

In another shell:

```bash
curl -fsS http://127.0.0.1:8765/api/mila/status
curl -fsS http://127.0.0.1:8765/api/obsidian/status
```

Stop the foreground server after the check.

## systemd service

Create:

```bash
sudo nano /etc/systemd/system/agentos-dashboard.service
```

Service:

```ini
[Unit]
Description=AgentOS Mila dashboard
After=network.target

[Service]
Type=simple
User=admilana
Group=admilana
WorkingDirectory=/home/admilana/agentos-runtime
EnvironmentFile=/home/admilana/agentos-runtime/.env
Environment=AGENTOS_ROOT=/home/admilana/agentos-runtime
Environment=AGENTOS_PORT=8765
Environment=OBSIDIAN_VAULT_PATH=/var/lib/agentos/obsidian-vault
ExecStart=/home/admilana/agentos-runtime/.venv/bin/python /home/admilana/agentos-runtime/dashboard/backend/app.py --workspace /home/admilana/agentos-runtime --host 127.0.0.1 --port 8765
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentos-dashboard
sudo systemctl status agentos-dashboard --no-pager
journalctl -u agentos-dashboard -n 80 --no-pager
```

## nginx/OpenResty proxy

Before changing the live domain, back up the current config:

```bash
sudo nginx -T > /root/nginx-before-agentos-$(date +%Y%m%dT%H%M%S).conf
```

Inside the existing `server_name agent.milanapremium.uz` server block, keep the
GitHub visual at `/`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Optional, only for runtime API debugging or later UI integration, expose the
Python AgentOS runtime under a prefix. Prefer keeping this internal until auth
and routing are reviewed:

```nginx
location /agentos-api/ {
    rewrite ^/agentos-api/(.*)$ /api/$1 break;
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /ws/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Check and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

If the GitHub app later proxies AgentOS runtime through its own Node backend,
remove the public `/agentos-api/` location and keep Python reachable only from
localhost.

## Production verification

After reload:

```bash
curl -I https://agent.milanapremium.uz/
curl -fsS https://agent.milanapremium.uz/api/health
curl -fsS http://127.0.0.1:8765/api/mila/status
curl -fsS http://127.0.0.1:8765/api/obsidian/status
```

Then open:

```text
https://agent.milanapremium.uz/
```

Expected:

- GitHub Agentic OS visual loads at `/`;
- `/api/health` returns the Node app health;
- local `127.0.0.1:8765/api/mila/status` returns `status: ok`;
- local `127.0.0.1:8765/api/obsidian/status` points to `/var/lib/agentos/obsidian-vault`;
- `hermes profile list` works under the same Linux user that runs AgentOS;
- release check remains `ready_local`.

## Updating production later

Copy the changed files, then:

```bash
cd /home/admilana/agentic-os
git pull --ff-only
docker compose up -d --build
curl -fsS http://127.0.0.1:8787/api/health

cd /home/admilana/agentos-runtime
.venv/bin/python agentosctl.py release check --pretty
.venv/bin/python -m pytest -q
sudo systemctl restart agentos-dashboard
sudo systemctl status agentos-dashboard --no-pager
```

## Rollback

If the new deployment fails:

```bash
sudo systemctl stop agentos-dashboard
sudo cp /root/nginx-before-agentos-TIMESTAMP.conf /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl reload nginx
```

If code was updated through git:

```bash
cd /opt/agentos
git log --oneline -5
git checkout PREVIOUS_GOOD_COMMIT
sudo systemctl restart agentos-dashboard
```

Do not run destructive git commands on production unless the exact rollback
target is known.

## What is manual right now

Manual server access is still required. Provide one of these:

1. SSH host, port, username, and key/password path. The username should be `admilana`, not `root`.
2. Access through a hosting control panel with terminal/file manager.
3. Add this machine's public SSH key to the production user and confirm the
   username and SSH port.
4. VPN access if the real server is only reachable on the private network.

Once access works, the deploy can be completed with the steps above.

Useful server-side SSH diagnostics:

```bash
hostname -I
ip -4 addr
sudo grep -E '^(AllowUsers|PasswordAuthentication|PubkeyAuthentication|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null
sudo journalctl -u ssh -n 80 --no-pager
```

Useful client-side connection attempts once the private IP is known:

```bash
ssh -i ~/.ssh/mila_vm105_codex2 -o IdentitiesOnly=yes admilana@SERVER_PRIVATE_IP
ssh -i ~/.ssh/mila_vm105_codex2 -o IdentitiesOnly=yes admilana@93.188.83.254
```
