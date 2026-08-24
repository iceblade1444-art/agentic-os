// GET /api/activity — what MILA did for the person asking, newest first.
//
// The caller's own id is the only key ever passed to the store, so this cannot
// be pointed at somebody else's feed: there is no user parameter to tamper
// with. Same shape of guarantee as needs-you — the role decision lives in the
// layer below, not in a query string.

import { Router } from "express";

import { activity } from "../lib/activity.js";
import { authenticatedUser } from "../lib/auth.js";

const r = Router();

r.get("/", (req, res) => {
  const user = req.user || authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  const limit = Number.parseInt(req.query.limit, 10);
  try {
    const items = activity.list(user.id, {
      limit: Number.isFinite(limit) ? limit : 40,
    });
    res.json({ items, count: items.length });
  } catch (error) {
    console.error(`[activity] ${error.message}`);
    res.status(500).json({ error: "Could not read the feed" });
  }
});

export default r;
