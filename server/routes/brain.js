import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { defaultSources, searchBrain } from "../lib/brain.js";

const r = Router();

r.get("/search", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    res.json(await searchBrain(req.query.q, defaultSources(user), { limit: req.query.limit }));
  } catch (error) { next(error); }
});

export default r;
