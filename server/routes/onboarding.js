import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { knowledge } from "../lib/knowledge.js";
import { onboarding, onboardingContextDocuments } from "../lib/onboarding.js";

const r = Router();

r.get("/", (req, res) => {
  res.json(onboarding.get(authenticatedUser(req)));
});

r.put("/", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const state = onboarding.update(user, req.body || {});
    const synced = [];
    for (const document of onboardingContextDocuments(user, state)) {
      await knowledge.upsert(document.path, document.content, { actor: user.name, source: "onboarding" });
      synced.push(document.path);
    }
    res.json({ ...state, contextSynced: true, synced });
  } catch (error) {
    if (error.code === "invalid_workspace") return res.status(400).json({ error: error.message, code: error.code });
    next(error);
  }
});

export default r;
