# Deploying Agentic OS + Hermes to your server

A copy-paste runbook. Assumes an **Ubuntu/Debian** server you reach over SSH.
(If it's a different distro, tell me and I'll adjust the package steps.)

> Run these **on the server** after you `ssh` in yourself. Nothing here needs your password
> embedded anywhere.

---

## 0. First: secure the access

```bash
# on the server — rotate the password you shared, and prefer key auth
passwd
# from YOUR laptop, install your SSH key so you don't type a password again:
#   ssh-copy-id admilana@172.16.10.6
```

Then lock down the firewall (we only expose 80/443 publicly, never 8787 directly):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

---

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out/in so `docker` works without sudo
docker --version
```

---

## 2. Get the code onto the server

Either push from your machine, or clone. From **your laptop** (where the project lives):

```bash
# option A — rsync the folder up (exclude local junk)
rsync -av --exclude node_modules --exclude data --exclude .git \
  "D:/Dev/Agentic OS/" admilana@172.16.10.6:~/agentic-os/

# option B — if you push it to a git remote, just clone on the server:
# git clone <your-repo-url> ~/agentic-os
```

For ongoing work, prefer a private Git remote. From any new computer, clone the
repository and create a fresh local `.env` from `.env.example`; do not copy the
server's production `.env` or `data/` into Git. To update an existing server
checkout safely:

```bash
cd ~/agentic-os
git pull --ff-only
docker compose up -d --build
curl -fsS http://127.0.0.1:8787/api/health
```

Docker keeps the production `.env`, `data/` and vault mount outside Git's update
flow, so a code pull does not replace production credentials or application data.

---

## 3. Configure & run

```bash
cd ~/agentic-os
cp .env.example .env
nano .env          # REQUIRED before exposing it:
                   #   AUTH_TOKEN=$(openssl rand -hex 32)   ← enables login/auth
                   #   SECURE_COOKIE=true                   ← you'll be behind HTTPS
                   #   OPENAI_API_KEY=sk-...                ← unlocks real missions + chat
                   #   leave ALLOW_CUSTOM_MCP=false

docker compose up -d --build
docker compose logs -f     # Ctrl-C to stop tailing
```

If the HTTPS reverse proxy runs on a **different machine**, publish the app on
the server's private address (do not use `127.0.0.1`):

```dotenv
BIND_ADDRESS=172.16.10.6
HOST_PORT=8787
```

Allow that port only from the reverse proxy's private IP in your firewall. When
nginx runs on the same server, keep the default `BIND_ADDRESS=127.0.0.1`.

Verify (from the server):

```bash
curl -s localhost:8787/api/health
# → {"ok":true,...,"providers":{"openai":true,...}}
```

The app is now on `127.0.0.1:8787` (localhost only — that's intentional).

---

## 4. Put it behind HTTPS (nginx + Let's Encrypt)

```bash
sudo apt update && sudo apt install -y nginx
sudo tee /etc/nginx/sites-available/agentic-os >/dev/null <<'NGINX'
server {
    server_name agentic.example.com;   # <-- your domain
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";   # keep SSE (chat + missions) streaming
        proxy_buffering off;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/agentic-os /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d agentic.example.com
```

> ✅ **Auth is built in.** With `AUTH_TOKEN` set, every `/api/*` call requires a login session
> (browser) or `Authorization: Bearer <AUTH_TOKEN>` (API clients like the Hermes bridge). The app
> also sends security headers + a CSP, rate-limits requests, and — with the default
> `ALLOW_CUSTOM_MCP=false` — refuses to spawn arbitrary commands. With `AUTH_TOKEN` + TLS +
> `SECURE_COOKIE=true`, it's safe to expose. (Belt-and-suspenders: you can still add nginx
> `auth_basic` on top.)

---

## 5. Install Hermes (the orchestrator, OpenAI brain)

On the **server** (or wherever you want Hermes to run — it just needs to reach the app URL):

```bash
# install per Nous Research docs (CLI installer)
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh   # see their install page
hermes model            # choose OpenAI, paste your key  → writes ~/.hermes/.env
```

Point Hermes at Agentic OS over MCP — edit `~/.hermes/config.yaml`:

```yaml
model:
  provider: openai
  default: gpt-4o

mcp_servers:
  agentic-os:
    command: "node"
    args: ["/home/admilana/agentic-os/server/mcp/agentic-os-server.js"]
    env:
      AGENTIC_OS_URL: "http://localhost:8787"
```

> The bridge is a Node script and needs Node ≥ 20 on the host **and** the app's deps
> (`cd ~/agentic-os && npm ci --omit=dev`). If you'd rather not install Node on the host, I can
> switch the bridge to an HTTP-MCP endpoint served by the container instead — just ask.

Test + first mission:

```bash
hermes mcp test agentic-os      # should list the agentic_* tools
hermes                          # then: "List the tools available in Agentic OS and add 21+21"
```

Watch it happen live on the **Missions** page of the dashboard.

### Install the official Hermes web dashboard

Agentic OS exposes the complete official Hermes Dashboard inside **Hermes Control**. Install its
optional web/PTTY dependencies and persistent user service after Hermes itself is configured:

```bash
cd ~/agentic-os
bash scripts/install-hermes-dashboard.sh
docker compose up -d --build
```

Open `https://agent.milanapremium.uz/#/hermes`. The existing Agentic OS session is reused; there is
no second browser login. Hermes listens only on `127.0.0.1:9119`, and a private owner-only Unix
socket connects it to the Node container. Do not add port `9119` to UFW or the public reverse
proxy. Both HTTP and WebSocket upgrades on `/hermes/` require a valid `aos_session` cookie.

Verify without printing credentials:

```bash
systemctl --user --no-pager status hermes-dashboard
systemctl --user --no-pager status hermes-dashboard-socket
~/.local/bin/hermes dashboard --status
docker compose logs --tail 100 agentic-os
```

---

## 6. Obsidian vault as an agent tool

Agentic OS ships an **`obsidian` MCP server** (`server/mcp/obsidian-server.js`) that exposes a
vault (a folder of `.md` files) to agents: `list_notes`, `read_note`, `search_notes`,
`create_note`, `append_note`. Hermes and the built-in orchestrator use it in missions.

1. **Put your vault where the container can see it.** Copy your Obsidian vault onto the server
   (e.g. `~/agentic-os/vault`), or mount an existing path by editing `docker-compose.yml`:
   ```yaml
   volumes:
     - /home/admilana/MyVault:/app/vault   # your real vault path : container path
   ```
   The bundled `./vault` has a couple of sample notes to start from.

2. **Restart** so the mount applies: `docker compose up -d`.

3. **Turn it on** — dashboard → **MCP Servers** → **Start** the `obsidian` server (or
   `POST /api/mcp/servers/mcp_obsidian/connect`). Its 5 tools appear and become reachable through
   the `agentic-os` bridge.

4. **Use it in a mission.** e.g. tell Hermes *"Search my vault for 'roadmap' and append a summary
   to Projects/Status.md"* — it runs `search_notes` + `append_note`. All paths are confined to the
   vault (no traversal outside).

> Want the vault to sync across devices too? I can add self-hosted Obsidian **LiveSync** (CouchDB)
> to the compose file — just ask.

---

## Security checklist

- [ ] `AUTH_TOKEN` set to a long random value (`openssl rand -hex 32`)
- [ ] `SECURE_COOKIE=true` and served over HTTPS (certbot)
- [ ] `ALLOW_CUSTOM_MCP=false` (default) — the UI can't spawn arbitrary commands
- [ ] `AGENTIC_OS_TOKEN` matches `AUTH_TOKEN` so the Hermes bridge authenticates (automatic when
      you only set `AUTH_TOKEN`)
- [ ] Firewall: only 80/443 (+ SSH); the app stays on `127.0.0.1:8787` behind nginx
- [ ] Hermes port `9119` is loopback-only; access is through the private socket and protected `/hermes/`
- [ ] Rotated the SSH password you shared earlier; using SSH keys
- [ ] `.env` and `data/` stay out of git (already in `.gitignore`)

---

## Updating later

```bash
cd ~/agentic-os && git pull   # or rsync again
docker compose up -d --build
```
