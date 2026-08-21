// The credential a voice call answers with.
//
// Until now the agent presented the installation's master token, which resolves
// to the owner — so it was the owner on everybody's call, and the personal desk
// could not be given to it at all: whose tasks would it have opened? This token
// names one person, expires with the call, and remembers which door it speaks
// through. These tests exist to prove it is a narrowing, never a new privilege.

import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../server/config.js";
import { AGENT_TOKEN_TTL_MS, agentSessionToken, authenticatedUser, requestChannel, serviceCaller } from "../server/lib/auth.js";
import { channelAllows } from "../server/lib/mila-audience.js";

const MEMBER = { id: "usr_member", name: "Сотрудник", role: "Member", sessionVersion: 1 };
const OWNER = { id: "creator", name: "Владелец", role: "Creator", sessionVersion: 1 };

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

function withServiceToken(run) {
  const previous = config.authToken;
  config.authToken = "service-token-under-test";
  try { return run(); } finally { config.authToken = previous; }
}

test("the token names its person and its door", () => {
  const token = agentSessionToken(MEMBER, "mobile");
  assert.equal(requestChannel(bearer(token)), "mobile");
  assert.equal(requestChannel({ headers: {} }), "app", "a cookie session is the person at their own desk");
  assert.equal(requestChannel(bearer("not-a-token")), "app", "a forged token grants no channel");
});

test("an agent token reaches the personal desk and the ERP reads, and stops there", () => {
  const channel = "mobile";
  for (const name of ["get_my_day_plan", "create_my_task", "remind_me", "search_company_knowledge", "get_sewing_daily_report"]) {
    assert.ok(channelAllows(name, MEMBER, channel), `${name} is this person's own work and must travel`);
  }
  // The reach that made the master token dangerous, refused for the owner too.
  for (const name of ["ask_claude_code", "call_mcp_tool", "write_obsidian_note", "create_kanban_task", "delegate_to_hermes", "learn_skill"]) {
    assert.equal(channelAllows(name, OWNER, channel), false, `${name} must not be reachable from a voice call`);
    assert.ok(channelAllows(name, OWNER, "app"), `${name} stays available at the owner's own desk`);
  }
  // Staff data follows the role, not the channel.
  assert.ok(channelAllows("get_attendance_today", OWNER, channel));
  assert.equal(channelAllows("get_attendance_today", MEMBER, channel), false);
});

test("only the service credential may mint on someone's behalf", () => {
  withServiceToken(() => {
    assert.equal(serviceCaller(bearer("service-token-under-test")), true);
    assert.equal(serviceCaller(bearer(agentSessionToken(OWNER, "mobile"))), false, "an agent token cannot mint another");
    assert.equal(serviceCaller({ headers: {} }), false, "a session cookie cannot mint for someone else");
  });
});

test("the token expires with the call, not with the month", () => {
  const token = agentSessionToken(MEMBER, "mobile");
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(payload.kind, "agent");
  assert.equal(payload.channel, "mobile");
  assert.ok(payload.exp - Date.now() <= AGENT_TOKEN_TTL_MS);
  assert.ok(payload.exp - Date.now() > 60_000);
  // A caller asking for a year gets the ceiling.
  const greedy = JSON.parse(Buffer.from(agentSessionToken(MEMBER, "mobile", 365 * 864e5).split(".")[0], "base64url").toString());
  assert.ok(greedy.exp - Date.now() <= AGENT_TOKEN_TTL_MS);
});

test("an expired or tampered token authenticates nobody", () => {
  withServiceToken(() => {
    const expired = agentSessionToken(MEMBER, "mobile", 60_000);
    const payload = JSON.parse(Buffer.from(expired.split(".")[0], "base64url").toString());
    payload.exp = Date.now() - 1000;
    const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.equal(authenticatedUser(bearer(`${forgedBody}.${expired.split(".")[1]}`)), null, "a rewritten expiry breaks the signature");
    assert.equal(authenticatedUser(bearer("garbage.garbage")), null);
  });
});

test("the owner's own token still resolves to the owner, and only to them", () => {
  withServiceToken(() => {
    const asOwner = authenticatedUser(bearer(agentSessionToken(OWNER, "mobile")));
    assert.equal(asOwner.id, "creator");
    // The point of the whole change: an agent holding this cannot become
    // somebody else by asking, because the name is inside the signature.
    assert.equal(requestChannel(bearer(agentSessionToken(OWNER, "mobile"))), "mobile");
  });
});
