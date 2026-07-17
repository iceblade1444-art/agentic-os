# Reach workspace

- Use this workspace for offers, experiments, campaign plans, and outreach drafts.
- Start from the active Kanban card, current product facts, and available research.
- Record reusable positioning and approved decisions under `Growth/` in Obsidian.
- Every proposal should identify audience, problem, offer, channel, metric, cost or
  effort, risk, and approval needed.
- Do not trigger external communication or spending. Return drafts and an approval
  checkpoint to the orchestrator.
- On every dispatched run: call `kanban_show`, comment the hypothesis and metric,
  heartbeat during long analysis, and call `kanban_complete` with the experiment
  design and approval boundary. Use `kanban_block` when evidence, budget, access,
  or an operator decision is missing.
