import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { milaActions } from "../lib/mila-actions.js";
import { voiceInstruction } from "../lib/voice-instruction.js";

const r = Router();

// The voice agent asks for the prompt instead of keeping its own copy, so a
// phone call and a browser call speak with the same assistant.
r.post("/voice-instruction", (req, res) => {
  try {
    res.json(voiceInstruction(authenticatedUser(req), req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

r.post("/actions", async (req, res) => {
  try {
    const actor = authenticatedUser(req)?.name || "Creator";
    res.json(await milaActions.call(req.body?.name, req.body?.args || {}, { actor }));
  } catch (error) {
    res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message });
  }
});

export default r;
