import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { knowledge } from "../lib/knowledge.js";
import { onboarding, onboardingContextDocuments, sharedAgentContext } from "../lib/onboarding.js";

const r = Router();

async function syncContext(user, state) {
  const synced = [];
  for (const document of onboardingContextDocuments(user, state)) {
    await knowledge.upsert(document.path, document.content, { actor: user.name, source: "onboarding" });
    synced.push(document.path);
  }
  return synced;
}

r.get("/", (req, res) => {
  const user = authenticatedUser(req);
  const state = onboarding.get(user);
  res.json({ ...state, agentContext: sharedAgentContext(user, state) });
});

r.put("/", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const state = onboarding.update(user, req.body || {});
    const synced = await syncContext(user, state);
    res.json({ ...state, agentContext: sharedAgentContext(user, state), contextSynced: true, synced });
  } catch (error) {
    if (error.code === "invalid_workspace") return res.status(400).json({ error: error.message, code: error.code });
    next(error);
  }
});

r.post("/sync-context", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const state = onboarding.get(user);
    const synced = await syncContext(user, state);
    res.json({ ok: true, synced, agentContext: sharedAgentContext(user, state) });
  } catch (error) { next(error); }
});

export default r;
