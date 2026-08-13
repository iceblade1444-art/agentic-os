import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

test("an expected refusal keeps its status instead of becoming a 500", () => {
  // Routes signal refusals by attaching a status to the error: "not a member" is
  // 403, "no such message" is 404, "unsupported reaction" is 400. The handler
  // reported every one of them as 500, so a validation message was
  // indistinguishable from a crashed server — and every one filled the log with
  // a stack trace for something working exactly as designed.
  const handler = server.slice(server.indexOf("app.use((err, req, res, next)"));
  assert.match(handler, /const status = Number\(err\?\.status\)/);
  assert.match(handler, /status >= 400 && status < 500/);
  assert.match(handler, /res\.status\(expected \? status : 500\)/);
  assert.equal(/res\.status\(500\)\.json\(\{ error: err\.message \}\)/.test(handler), false);
});

test("a genuine fault is still a 500 and still logged loudly", () => {
  const handler = server.slice(server.indexOf("app.use((err, req, res, next)"));
  assert.match(handler, /else console\.error\("\[error\]", err\)/);
  // A 5xx a route asked for is not treated as an expected refusal either.
  assert.match(handler, /Number\.isInteger\(status\)/);
});
