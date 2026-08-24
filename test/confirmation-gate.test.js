// The gate, and the thing that was actually missing from it.
//
// A write action without a token has always refused to run — that part worked
// and I said otherwise before checking, which was wrong. What did not work is
// that a staged action was invisible: MILA would prepare a cancellation, the
// conversation would end, and five minutes later it expired with the question
// never having been asked. A gate nobody can answer only ever says no.
//
// So these cover three things: that the refusal is real, that a staged action
// now surfaces where a person will see it, and that the one destructive
// personal action that ran immediately no longer does.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { awaitingConfirmation, SEVERITY } from "../server/lib/needs-you.js";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const ACTIONS = read("server/lib/mila-actions.js");
const ROUTE = read("server/routes/mila-actions.js");
const NEEDS = read("server/routes/needs-you.js");

test("forgetting a fact is no longer done on the way past", () => {
  // Everything else on the personal desk adds something and is one tap to
  // undo. This one deletes, and afterwards MILA does not know the fact was
  // ever true.
  assert.match(ACTIONS, /const CONFIRMED_PERSONAL_ACTIONS = new Set\(\["forget_about_me"\]\);/);
  // Listed is not enough — the dispatcher has to consult it.
  assert.match(ACTIONS, /const gated = WRITE_ACTIONS\.has\(action\) \|\| CONFIRMED_PERSONAL_ACTIONS\.has\(action\);/);
  assert.match(ACTIONS, /if \(gated\) \{/);
  // And it must still run through the read path, where its handler lives.
  assert.match(ACTIONS, /\? await executeWrite\(action, confirmed, scope\)\s*\r?\n\s*: await executeRead\(action, confirmed, scope\);/);
});

test("the staged action describes itself in a sentence a person can judge", () => {
  // "Run Agentic OS action" is not something anyone can approve or refuse.
  assert.match(ACTIONS, /if \(name === "forget_about_me"\) return `Forget the fact/);
  assert.match(ACTIONS, /if \(name === "forget_about_me"\) return \{ factId: bounded\(args\.factId, 120\) \};/,
    "and its arguments must survive cleanMutationArgs, which returns {} by default");
});

test("what MILA is holding reaches the queue a person actually reads", () => {
  const rows = awaitingConfirmation([
    {
      token: "tok_1", action: "cancel_calendar_event",
      summary: "Cancel calendar event evt_9",
      stagedAt: "2026-08-24T09:00:00.000Z", expiresAt: "2026-08-24T09:05:00.000Z",
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "confirmation");
  assert.equal(rows[0].title, "Cancel calendar event evt_9");
  assert.equal(rows[0].confirmationToken, "tok_1");
  // Worst tier: it is not late, it is stopped, and it stops for good shortly.
  assert.equal(rows[0].severity, "blocked");
  assert.equal(SEVERITY.indexOf(rows[0].severity), 0);
});

test("a queue built from nothing is empty, not broken", () => {
  for (const input of [undefined, null, "", 42, {}]) {
    assert.deepEqual(awaitingConfirmation(input), [], `${JSON.stringify(input)} threw or leaked`);
  }
  assert.deepEqual(awaitingConfirmation([]), []);
});

test("a staged row without a summary still says something", () => {
  const [row] = awaitingConfirmation([{ token: "t", action: "learn_skill", summary: "" }]);
  assert.equal(row.title, "MILA ждёт подтверждения");
  assert.equal(row.detail, "learn_skill");
});

test("the queue is capped, so one runaway session cannot fill the screen", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ token: `t${i}`, summary: `s${i}` }));
  assert.equal(awaitingConfirmation(many).length, 10);
});

test("everyone gets their own staged actions, Member included", () => {
  // These belong to no fleet, so they sit on the personal side of the operator
  // gate rather than behind it.
  const source = read("server/lib/needs-you.js");
  const composer = source.slice(source.indexOf("export async function needsYou"));
  const personal = composer.slice(0, composer.indexOf("if (!isOperator)"));
  assert.match(personal, /awaitingConfirmation\(deps\.staged\(user\.id\)\)/,
    "staged actions must be added before the operator-only branch");
  // And the route supplies them keyed by the caller, with no user parameter.
  assert.match(NEEDS, /staged: \(id\) => milaActions\.listPending\(id\)/);
});

test("a confirmation can be answered, and declining is a real answer", () => {
  assert.match(ROUTE, /r\.post\("\/confirm"/);
  assert.match(ROUTE, /decision !== "approve" && decision !== "decline"/);
  assert.match(ROUTE, /milaActions\.decline\(token, user\.id\)/,
    "no should remove it, not leave it lingering for five minutes");
});

test("approval runs what was described, not what the request claims", () => {
  // Only the token travels. The arguments come from the store, so a second
  // request cannot swap the payload after the person read the summary.
  assert.match(ROUTE, /milaActions\.call\(staged\.action, \{ confirmationToken: token \}/);
  // And the channel rules still apply: a voice call must not be able to
  // approve something a voice call could never have started.
  const confirm = ROUTE.slice(ROUTE.indexOf('r.post("/confirm"'));
  assert.match(confirm, /if \(!permitted\(req, staged\.action\)\)/);
});

test("somebody else's token is not found rather than refused", () => {
  // The lookup is over the caller's own staged actions, so a token belonging to
  // another account is simply absent. Answering 409 for both means the response
  // cannot be used to learn that a token exists.
  const confirm = ROUTE.slice(ROUTE.indexOf('r.post("/confirm"'));
  assert.match(confirm, /milaActions\.listPending\(user\.id\)\.find\(\(item\) => item\.token === token\)/);
  assert.match(confirm, /status\(409\)/);
  assert.doesNotMatch(confirm.slice(0, confirm.indexOf("decline")), /status\(403\)/,
    "a missing token must not answer differently from an expired one");
});

test("listing is scoped by the account, and by nothing the caller can choose", () => {
  assert.match(ROUTE, /r\.get\("\/pending"/);
  const pending = ROUTE.slice(ROUTE.indexOf('r.get("/pending"'), ROUTE.indexOf('r.post("/confirm"'));
  assert.match(pending, /milaActions\.listPending\(user\.id\)/);
  assert.doesNotMatch(pending, /req\.(query|params|body)/,
    "there must be no parameter that could point this at another person");
});
