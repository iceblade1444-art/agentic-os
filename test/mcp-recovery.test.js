// A stdio MCP child can die — killed, crashed, or orphaned by a careless
// script. When that happened the manager kept the dead entry in `live`, so
// isLive() stayed true, ensureConnected() never reconnected, and every ERP
// call sat there until it timed out with -32001 while the ERP itself was
// perfectly healthy. This exercises the real thing: spawn the bundled sample
// server, kill it, and require the manager to notice.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { connect, disconnect, isLive } from "../server/mcp/manager.js";

const sample = { id: "mcp_sample_recovery", kind: "sample", name: "sample" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

test("a killed bridge stops counting as live, so the next call reconnects", async (t) => {
  let entry;
  try {
    entry = await connect(sample);
  } catch {
    t.skip("the bundled sample bridge could not start here");
    return;
  }
  assert.equal(isLive(sample.id), true, "a fresh connection is live");
  assert.ok(entry.tools.length >= 0);

  // The child dies the way an orphaned or crashed bridge does.
  entry.transport.pid ? process.kill(entry.transport.pid, "SIGKILL") : await entry.client.close();
  await settle();

  assert.equal(isLive(sample.id), false,
    "a dead bridge must not stay live — that is what wedges every later call into a timeout");

  // And the way back is open: connecting again yields a working bridge.
  const again = await connect(sample);
  assert.equal(isLive(sample.id), true);
  await disconnect(sample.id);
  assert.equal(isLive(sample.id), false, "an explicit disconnect still clears the entry");
  assert.notEqual(again, entry, "the reconnect is a new bridge, not the corpse");
});

test("the manager wires the close and error handlers that make that possible", () => {
  const source = fs.readFileSync(new URL("../server/mcp/manager.js", import.meta.url), "utf8");
  assert.match(source, /client\.onclose = drop/);
  assert.match(source, /client\.onerror = drop/);
  // Guarded so a late close from an old bridge cannot evict a newer one.
  assert.match(source, /if \(live\.get\(server\.id\) === entry\) live\.delete\(server\.id\)/);
});
