import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("voice telemetry is passive, bounded and never stores speech contents", () => {
  const store = fs.readFileSync(new URL("../server/lib/voice-metrics.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/telemetry.js", import.meta.url), "utf8");
  const session = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

  assert.match(store, /MAX_EVENTS = 2000/);
  assert.match(store, /turn_response/);
  assert.match(store, /turnCompletionRate/);
  assert.doesNotMatch(store, /transcript|audioData|speechText/);
  assert.match(route, /requireRoles\("Creator", "Admin"\)/);
  assert.match(session, /this\.metric\("stt_warning"\)/);
  assert.match(session, /this\.metric\("turn_completed"/);
  assert.match(server, /app\.use\("\/api\/telemetry", telemetry\)/);
});
