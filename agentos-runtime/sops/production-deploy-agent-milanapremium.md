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

Hermes is the primary AgentOS orchestrator. It creates bounded plans for goals;
AgentOS validates those plans and executes them through approval-gated queues.
The current production profile is `default`, provider `openai-codex`, model
`gpt-5.5`. Mila/Gemini Live is the voice assistant, not the orchestrator.

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

After setup, verify the integrated role through the private runtime:

```bash
curl -fsS http://127.0.0.1:8765/api/orchestrator/status
curl -fsS http://127.0.0.1:8765/api/mila/status
```

The first response must report `primary: true` and `ready: true`; the second
must report Mila as `voice_assistant` linked to Hermes.

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

The official dashboard is installed and managed separately from the bounded
planner process. From the canonical checkout:

```bash
cd /home/admilana/agentic-os
bash scripts/install-hermes-dashboard.sh
docker compose up -d --build
systemctl --user --no-pager status hermes-dashboard
```

It listens only on `127.0.0.1:9119`. A user service forwards a private Unix
socket into the Node container, avoiding any Docker-to-host network exception.
The only supported browser entry is the authenticated same-origin route
`https://agent.milanapremium.uz/hermes/`; the existing Agentic OS session is the
browser gate. A scrypt fallback hash and separate private signing key remain in
the user-only config for fail-closed operation if the bind mode changes later.

### Obsidian

The Obsidian desktop app is not required on a headless production server.
Obsidian vaults are folders containing Markdown files and a `.obsidian`
configuration folder.

For production, create a server vault directory:

```bash
mkdir -p /home/admilana/agentic-os/vault/.obsidian
```

The compose service mounts that host directory at `/app/obsidian-vault` and
sets:

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
nano /home/admilana/agentic-os/agentos-runtime/.env
```

Minimum useful file:

```dotenv
GEMINI_API_KEY=replace_me
GOOGLE_API_KEY=replace_me
OBSIDIAN_VAULT_PATH=/app/obsidian-vault
AGENTOS_PORT=8765
```

Optional, only if those providers are enabled later:

```dotenv
OPENAI_API_KEY=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

## First server setup

The current production deployment uses Docker Compose for both services. Run it
as `admilana`, who is already a member of the `docker` group:

```bash
cd /home/admilana
git clone git@github.com:iceblade1444-art/agentic-os.git agentic-os
cd /home/admilana/agentic-os
cp .env.example .env
cp agentos-runtime/.env.example agentos-runtime/.env
chmod 600 .env agentos-runtime/.env
mkdir -p vault/.obsidian
docker compose up -d --build
```

Hermes remains installed for the host user and is mounted read-only into the
runtime container. Verify the combined deployment:

```bash
docker compose ps
docker exec agentos-runtime hermes --version
curl -fsS http://127.0.0.1:8765/api/mila/status
curl -fsS http://127.0.0.1:8765/api/obsidian/status
curl -fsS http://172.16.10.6:8787/api/health
```

Run the full test suite before publishing a runtime update:

```bash
cd /home/admilana/agentic-os/agentos-runtime
python3 -m pytest -q
python3 agentosctl.py --workspace . release check --pretty
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
- local `127.0.0.1:8765/api/obsidian/status` points to `/app/obsidian-vault`;
- `hermes profile list` works under the same Linux user that runs AgentOS;
- release check remains `ready_local`.

## Updating production later

Pull the canonical GitHub `main`, then rebuild both services:

```bash
cd /home/admilana/agentic-os
git pull --ff-only
docker compose up -d --build
docker compose ps
curl -fsS http://172.16.10.6:8787/api/health
curl -fsS http://127.0.0.1:8765/api/mila/status
```

## Rollback

If a new runtime image fails, inspect logs and return to the previous known
commit before rebuilding:

```bash
cd /home/admilana/agentic-os
docker compose logs --tail 100 agentos-runtime
git log --oneline -5
git revert BAD_COMMIT
docker compose up -d --build
```

Do not run destructive git commands on production unless the exact rollback
target is known.

## Access and maintenance

Production SSH is available on the private network as `admilana@172.16.10.6`.
The public IP is behind NAT, so use the private address from this workstation.
The deploy key used by Codex has fingerprint:

```text
SHA256:ctpIkSilaZ8zM5pybvvN4c33ht3sWEIzpXFJATNKwlY
```

Useful server-side diagnostics:

```bash
hostname -I
ip -4 addr
sudo grep -E '^(AllowUsers|PasswordAuthentication|PubkeyAuthentication|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null
sudo journalctl -u ssh -n 80 --no-pager
```

Client connection:

```bash
ssh -i ~/.ssh/agentos_codex_deploy -o IdentitiesOnly=yes admilana@172.16.10.6
```
