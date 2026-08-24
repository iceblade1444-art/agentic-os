import { Router } from "express";

import { agentSessionToken, AGENT_TOKEN_TTL_MS, authenticatedUser, requestChannel, serviceCaller } from "../lib/auth.js";
import { milaActions, READ_ONLY_ERP_ACTIONS } from "../lib/mila-actions.js";
import { channelAllows } from "../lib/mila-audience.js";
import { users } from "../lib/users.js";
import { creatorUser } from "../lib/auth.js";
import { voiceInstruction } from "../lib/voice-instruction.js";

const r = Router();

// Two questions, and the answer to both lives in mila-audience.js: may this
// person call this at all, and does the door they came through carry it. At
// their own desk an operator has everything; a voice call or a chat message
// carries the personal desk, company knowledge and the ERP reads — never
// Kanban, Hermes, Obsidian, Claude Code or MCP, because voice must not be a
// side door to the host.
const permitted = (req, name) => channelAllows(name, authenticatedUser(req), requestChannel(req));
// A Member reads exactly what the ERP panel already shows them, so the gate is
// not a widening of their access — it is the same access through another door.
void READ_ONLY_ERP_ACTIONS;

// The voice agent asks for the prompt instead of keeping its own copy, so a
// phone call and a browser call speak with the same assistant.
r.post("/voice-instruction", (req, res) => {
  try {
    // An agent token already says which door it speaks through; taking the
    // channel from the credential rather than the body means a caller cannot
    // ask for a wider set than it was issued.
    const channel = requestChannel(req);
    // The master token is the installation, not a person. It resolves to the
    // owner, so a voice agent presenting it used to receive the owner's private
    // context and carry it into everybody's call. Saying "this caller is not
    // identified" drops the private half; an agent token naming the person
    // restores it, because then the context belongs to whoever is on the line.
    const identified = !(serviceCaller(req) && channel === "app");
    const body = { ...(req.body || {}), identified, ...(channel === "app" ? {} : { channel }) };
    res.json(voiceInstruction(authenticatedUser(req), body));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mints the credential a voice agent answers a call with. Only the service
// token may ask — a session cookie must never be able to mint a token for
// somebody else — and what comes back is bound to one person, one channel and
// the length of a call. It grants nothing on its own: every action it is used
// for is checked against that channel, so this is a narrowing of the master
// token the agent uses today, not a new privilege.
r.post("/agent-token", (req, res) => {
  if (!serviceCaller(req)) {
    return res.status(403).json({ error: "forbidden", code: "service_token_required" });
  }
  const channel = String(req.body?.channel || "mobile").slice(0, 20);
  const userId = String(req.body?.userId || "").slice(0, 64);
  if (!userId) return res.status(400).json({ error: "userId is required" });
  const user = userId === "creator" ? creatorUser() : users.sessionUser(userId);
  if (!user || user.disabled) return res.status(404).json({ error: "unknown or disabled account" });
  res.json({
    token: agentSessionToken(user, channel),
    expiresInSeconds: Math.floor(AGENT_TOKEN_TTL_MS / 1000),
    channel,
    user: { id: user.id, name: user.name, role: user.role },
  });
});

r.post("/actions", async (req, res) => {
  try {
    const name = String(req.body?.name || "");
    if (!permitted(req, name)) {
      return res.status(403).json({ error: "forbidden", code: "mila_action_restricted", channel: requestChannel(req) });
    }
    const user = authenticatedUser(req);
    res.json(await milaActions.call(name, req.body?.args || {}, { actor: user?.name || "Creator", user }));
  } catch (error) {
    res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message });
  }
});

// What MILA is holding, and the answer to it.
//
// The gate has always refused to run an unconfirmed write. What it could not
// do is be answered anywhere except by continuing the same conversation, so a
// staged action whose chat ended simply expired unasked. These two make it a
// queue: the phone shows it in "needs you" and answers it from there.
r.get("/pending", (req, res) => {
  const user = authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  const items = milaActions.listPending(user.id);
  res.json({ items, count: items.length });
});

r.post("/confirm", async (req, res) => {
  const user = authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  const token = String(req.body?.token || "").slice(0, 200);
  const decision = String(req.body?.decision || "");
  if (decision !== "approve" && decision !== "decline") {
    return res.status(400).json({ error: "Decision must be approve or decline" });
  }

  // Looked up among this person's own staged actions. Someone else's token is
  // simply not in the list, so it reads as expired rather than as forbidden —
  // there is nothing to learn from the difference.
  const staged = milaActions.listPending(user.id).find((item) => item.token === token);
  if (!staged) {
    return res.status(409).json({ error: "Confirmation expired or does not match this action" });
  }

  if (decision === "decline") {
    milaActions.decline(token, user.id);
    return res.json({ ok: true, decision, action: staged.action, summary: staged.summary });
  }

  // The same door as any other call, so the channel rules still apply: a voice
  // call cannot approve something a voice call was never allowed to start.
  if (!permitted(req, staged.action)) {
    return res.status(403).json({ error: "forbidden", code: "mila_action_restricted", channel: requestChannel(req) });
  }
  try {
    // Only the token travels. The arguments are the ones that were staged, so
    // what runs is what was described to the person, not what a later request
    // says it was.
    const result = await milaActions.call(staged.action, { confirmationToken: token }, {
      actor: user.name || "Creator", user,
    });
    res.json({ ok: true, decision, action: staged.action, result });
  } catch (error) {
    res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message });
  }
});

export default r;
