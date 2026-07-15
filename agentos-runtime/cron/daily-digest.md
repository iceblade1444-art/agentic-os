# AgentOS Daily Digest Cron Template

## Purpose
Generate a daily AgentOS summary with project counts, pending approvals, blocked tasks, and recent events.

## Script

```text
C:\Users\User\AgentOS\scripts\daily_digest.py
```

## Hermes cron command

From Hermes CLI, create a daily job:

```bash
hermes cron create "0 9 * * *" --script "C:\Users\User\AgentOS\scripts\daily_digest.py" --name "AgentOS daily digest"
```

If creating through the AgentOS UI/tooling, use this script as a no-agent job or as pre-run context for a digest notification.

## Manual test

```bash
python "C:\Users\User\AgentOS\scripts\daily_digest.py"
```
