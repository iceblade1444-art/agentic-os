# trading/ — gold trading agent (XAUUSD, MetaTrader 5)

- `agentos_trading.py` — AgentOS side: `/api/trading/status|events|report`, `POST /api/trading/control`
  with risk classes and approval gates (see `agents/trading-agent.md`).
- `xau_bridge.py` — reads/writes the EA's bridge files (`status.json`, `events.jsonl`, `control.txt`);
  the same file is installed for Hermes as `~/.hermes/scripts/xau_bridge.py`.
- `gold.py` — analysis: `timemachine`, `backtest`, `compare`, `replay`, `status`, `setfile` on the EA's M5 export.
- `mt5/XAU_SessionBreakout.mq5` — the Expert Advisor (v2.10, makes every trading decision);
  `mt5/ExportBars.mq5` — history export script.

Deployment, Docker mount, Hermes/Claude and Telegram: `sops/trading-gold.md`.
Configuration: `config/trading.json` (`allow_real_account` stays false on demo).
Education and tooling, not financial advice.
