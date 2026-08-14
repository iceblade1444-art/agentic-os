import { Router } from "express";

import { authenticatedUser } from "../lib/auth.js";
import { meetingMinutes } from "../lib/meeting-minutes.js";
import { onboarding } from "../lib/onboarding.js";

// Meeting minutes from a Speech Studio transcript. Operator-gated in index.js:
// the protocol lands in the vault, which is operator ground.
const r = Router();

r.post("/minutes", async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const timezone = onboarding.get(user)?.profile?.timezone || "Asia/Tashkent";
    res.json(await meetingMinutes.minutes(req.body?.transcript, { actor: user?.name || "оператор", timezone }));
  } catch (error) { next(error); }
});

export default r;
