# Runtime data

AgentOS keeps source code and live operating data in the same workspace tree, but
Git tracks only source files, stable agent specifications, workflow definitions,
and example configuration.

The following paths are live data and are intentionally ignored:

- `agents/queue.json`
- `approvals/approvals.json`
- `projects/`, `work/`, `artifacts/`, `drafts/`, and `exports/`
- `logs/events.json`, `logs/agent-queue/`, and `logs/agent-worker/`
- `workflow/seo_runs.json`
- `config/agent-worker.json`, `config/profile-mapping.json`, and
  `config/voice.local.json`
- `voice/input.txt` and `voice/transcripts/`
- the deployed vault's `.obsidian/` settings and `MILA/` notes

The runtime creates missing directories and JSON state files on first use.
Configuration examples use the `.example.json` suffix and remain tracked.

## Backup

Back up live data before deployment or migration:

```bash
tar -czf "$HOME/agentos-runtime-$(date +%Y%m%d-%H%M%S).tar.gz" \
  agentos-runtime/agents/queue.json \
  agentos-runtime/approvals \
  agentos-runtime/artifacts \
  agentos-runtime/config/agent-worker.json \
  agentos-runtime/config/profile-mapping.json \
  agentos-runtime/config/voice.local.json \
  agentos-runtime/logs \
  agentos-runtime/projects \
  agentos-runtime/work \
  agentos-runtime/workflow/seo_runs.json \
  vault/.obsidian \
  vault/MILA
```

Do not commit a runtime backup: it can contain private business context,
conversation history, and operational metadata.
