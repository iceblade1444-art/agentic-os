// Four days of morning briefs shipped without a production block. The ERP
// was answering the whole time; the app's own bridge to it was not. Two
// things made that possible, and both are pinned here:
//
// 1. connect() checked the map and then spawned, with twenty async lines in
//    between. Every caller that arrived during those lines spawned its own
//    bridge — three per digest read, nine per ERP page — and all but one
//    became orphans that lived for days.
// 2. A bridge that was alive but deaf was indistinguishable from a slow one.
//    Every call waited the SDK's full minute and failed; nothing ever
//    replaced it.
import assert from "node:assert/strict";
import test from "node:test";

import { CALL_TIMEOUT_MS, callTool, connect, disconnect, internals, isLive } from "../server/mcp/manager.js";

const sample = { id: "mcp_sample_race", kind: "sample", name: "sample" };

test("callers that arrive while a bridge is spawning share it instead of spawning their own", async (t) => {
  let entries;
  try {
    entries = await Promise.all([connect(sample), connect(sample), connect(sample)]);
  } catch {
    t.skip("the bundled sample bridge could not start here");
    return;
  }
  try {
    assert.equal(entries[0], entries[1]);
    assert.equal(entries[1], entries[2], "three concurrent connects, one bridge");
    assert.equal(internals.pending.size, 0, "the in-flight promise is released once the spawn settles");
    assert.equal(isLive(sample.id), true);
  } finally {
    await disconnect(sample.id);
  }
});

test("a call that times out evicts the bridge and closes its process", async () => {
  const closed = [];
  const timeout = Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 });
  const entry = {
    tools: [],
    transport: {},
    client: {
      callTool: async () => { throw timeout; },
      close: async () => { closed.push("closed"); },
    },
  };
  internals.live.set("mcp_deaf", entry);
  await assert.rejects(() => callTool("mcp_deaf", "anything", {}), /timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isLive("mcp_deaf"), false, "a deaf bridge is not live");
  assert.deepEqual(closed, ["closed"], "and its process is told to go, not left as an orphan");
});

test("other errors leave the bridge alone — a bad tool name is an answer, not a corpse", async () => {
  const entry = {
    tools: [],
    transport: {},
    client: {
      callTool: async () => { throw Object.assign(new Error("MCP error -32602: Unknown tool"), { code: -32602 }); },
      close: async () => { throw new Error("must not be called"); },
    },
  };
  internals.live.set("mcp_alive", entry);
  await assert.rejects(() => callTool("mcp_alive", "nope", {}), /Unknown tool/);
  assert.equal(isLive("mcp_alive"), true);
  internals.live.delete("mcp_alive");
});

test("the call timeout is far below the SDK's minute, and callers can still raise it", async () => {
  assert.ok(CALL_TIMEOUT_MS <= 30000, "a morning brief cannot spend a minute per tool");
  const seen = [];
  internals.live.set("mcp_opts", {
    tools: [], transport: {},
    client: { callTool: async (_params, _schema, options) => { seen.push(options?.timeout); return { content: [] }; }, close: async () => {} },
  });
  await callTool("mcp_opts", "quick", {});
  await callTool("mcp_opts", "slow", {}, { timeout: 120000 });
  assert.deepEqual(seen, [CALL_TIMEOUT_MS, 120000]);
  internals.live.delete("mcp_opts");
});

test("evicting a stale entry never removes the bridge that replaced it", () => {
  const older = { client: { close: async () => {} } };
  const newer = { client: { close: async () => {} } };
  internals.live.set("mcp_swap", newer);
  internals.evict("mcp_swap", older);
  assert.equal(internals.live.get("mcp_swap"), newer, "a late close from an old bridge must not evict the new one");
  internals.live.delete("mcp_swap");
});
