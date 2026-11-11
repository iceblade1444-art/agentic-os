# SOP: Gold trading agent (XAUUSD, MT5) on agent.milanapremium.uz

Status: new, demo account only until reviewed
Updated: 2026-10-28

## What runs where

```text
host (Ubuntu, user admilana)
  Xvfb :99 + x11vnc (localhost)       virtual screen for MT5, VNC only through an SSH tunnel
  ~/.mt5 (Wine) -> MetaTrader 5       demo account, XAUUSD M5 chart, XAU_SessionBreakout EA v2.10+
      Common/Files/xau_bridge/<login>_<symbol>/
          status.json  events.jsonl  control.txt  XAUUSD_M5.csv
  ~/.local/bin/hermes                 Hermes (orchestrator), trader-gold skill, xau-watch cron -> Telegram
docker compose (agentic-os repo)
  agentos-runtime  127.0.0.1:8765     this runtime: /api/trading/*, approvals, events
      /app/trading-bridge  <- bind mount of the xau_bridge folder above
```

The EA decides every trade. AgentOS and Hermes read its files and pass operator
commands through `control.txt` (pause, signals, lower risk, approved resume /
auto / session / close-all). Risk classes and approvals: `agents/trading-agent.md`.

## 1. MT5 on the host (once)

Use the helper from the `hermes-trader-gold` package (`mt5/setup_mt5_headless.sh`):

```bash
./mt5/setup_mt5_headless.sh install    # xvfb, x11vnc on localhost:5901, systemd user units
./mt5/setup_mt5_headless.sh mt5        # official MetaQuotes mt5linux.sh into ~/.mt5
# from a workstation: ssh -L 5901:localhost:5901 admilana@172.16.10.6, then VNC to localhost:5901
```

In MT5 (VNC): open a demo account (save password), Tools > Options > Charts >
Max bars in chart = Unlimited.

## 2. EA and Hermes skill (host)

```bash
cd hermes-trader-gold && ./install.sh     # skill -> ~/.hermes/skills/trading/trader-gold, scripts -> ~/.hermes/scripts,
                                          # EA -> MQL5/Experts and compile via MetaEditor under Wine
```

In VNC: XAUUSD M5 chart, attach `XAU_SessionBreakout`, inputs default
(`Server bridge` = true), Algo Trading on. Then autostart:

```bash
./mt5/setup_mt5_headless.sh service
python3 ~/.hermes/scripts/xau_bridge.py doctor
```

The EA source of truth is `trading/mt5/` in this runtime; the package carries the same files.

## 3. Mount the bridge into the runtime container

Find the folder:

```bash
find ~/.mt5 -type d -name xau_bridge -path "*Common/Files*"
```

In the agentic-os repo's `docker-compose.yml`, service `agentos-runtime`:

```yaml
    volumes:
      - /home/admilana/.mt5/drive_c/users/admilana/AppData/Roaming/MetaQuotes/Terminal/Common/Files/xau_bridge:/app/trading-bridge
    environment:
      - XAU_BRIDGE_DIR=/app/trading-bridge
```

(Use the path `find` printed. The mount must be writable: AgentOS writes `control.txt`.)

```bash
docker compose up -d --build agentos-runtime
curl -fsS http://127.0.0.1:8765/api/trading/status
```

Expected: `"status": "ok"`, `"account_mode": "demo"`, `"stale": false`.

## 4. Hermes on Claude

The orchestrator model is a Hermes setting, not an AgentOS one. As `admilana`:

```bash
hermes config set ANTHROPIC_API_KEY <key>       # stored in ~/.hermes/.env, never in AgentOS files
hermes config set model anthropic/<claude model> # e.g. the model your Anthropic account offers
hermes config get model
hermes doctor
```

Then record the new provider/model for the dashboard (they are display values;
AgentOS calls `hermes chat` and Hermes uses its own model):

- `config/orchestrator.json`: `"provider": "anthropic"`, `"model": "<value of hermes config get model>"`
- `agents/registry.json` (hermes entry): `"reasoning_provider": "anthropic"`, `"model": ...`
- `tests/test_agent_registry.py`: the `reasoning_provider` assertion

## 5. Telegram and schedules (Hermes)

```bash
cd hermes-trader-gold && ./install.sh --cron
hermes cron list
```

- `xau-watch` every minute, no LLM: EA events -> Telegram.
- `xau-briefing` weekdays 05:30 UTC, `xau-weekly` Saturday 08:00 UTC: Claude via the trader-gold skill.

With AgentOS available, the Hermes skill sends controls through
`POST http://127.0.0.1:8765/api/trading/control`, so medium/high commands land in
AgentOS Approvals instead of going straight to the EA.

## Verification

```bash
curl -fsS http://127.0.0.1:8765/api/trading/status | python3 -m json.tool | head -40
curl -fsS -X POST http://127.0.0.1:8765/api/trading/control -H 'Content-Type: application/json' -d '{"action":"pause"}'
curl -fsS -X POST http://127.0.0.1:8765/api/trading/control -H 'Content-Type: application/json' -d '{"action":"resume"}'   # -> approval_requested
curl -fsS http://127.0.0.1:8765/api/approvals | python3 -m json.tool | tail -20
```

Approve the resume in the dashboard; the approval's `trading_gate_result` must
show `"acknowledged": true`.

## Safety

- Demo account first, for weeks. `allow_real_account` stays false until the
  operator decides otherwise.
- Pause always works; open trades keep their stop, target and flat-by time.
- Never put broker logins, VNC passwords or API keys in this repo, logs or
  reports. Broker login stays in MT5; API keys in `~/.hermes/.env` / `.env`.
- Education and tooling, not financial advice.
