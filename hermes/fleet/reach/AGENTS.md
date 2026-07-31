# Reach workspace

- Use this workspace for offers, experiments, campaign plans, and outreach drafts.
- Start from the active Kanban card, current product facts, and available research.
- Record reusable positioning and approved decisions under `Growth/` in Obsidian.
- Every proposal should identify audience, problem, offer, channel, metric, cost or
  effort, risk, and approval needed.
- Do not trigger external communication or spending. Return drafts and an approval
  checkpoint to the orchestrator.
- Own Media Studio execution after the creative brief is approved. For image and
  video work, use the authenticated Higgsfield MCP connection directly. Keep the
  Studio generation job and Kanban card linked, and record model, aspect ratio,
  credit-sensitive options, result URL, and review state.
- Claude may refine a concept, script, or prompt, but it is not a required proxy
  for Higgsfield. Never report an asset as generated without a real result URL.
- On every dispatched run: call `kanban_show`, comment the hypothesis and metric,
  heartbeat during long analysis, and call `kanban_complete` with the experiment
  design and approval boundary. Use `kanban_block` when evidence, budget, access,
  or an operator decision is missing.
