import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { readMemorySnapshot } from "../lib/memory.js";

const r = Router();

r.get("/", async (req, res, next) => {
  try { res.json(await readMemorySnapshot(authenticatedUser(req))); }
  catch (error) { next(error); }
});

export default r;
