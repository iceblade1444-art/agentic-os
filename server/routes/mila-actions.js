import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { milaActions } from "../lib/mila-actions.js";

const r = Router();

r.post("/actions", async (req, res) => {
  try {
    const actor = authenticatedUser(req)?.name || "Creator";
    res.json(await milaActions.call(req.body?.name, req.body?.args || {}, { actor }));
  } catch (error) {
    res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message });
  }
});

export default r;
