// The bridge already retried a dead pipe once on a fresh connection. A
// request that timed out is the same situation seen from the other side —
// the manager has evicted that bridge — so it gets the same single retry,
// and a real ERP answer still comes back as itself.
import assert from "node:assert/strict";
import test from "node:test";

import { createErpBridge } from "../server/lib/erp-bridge.js";

const SERVER = { id: "mcp_erp", kind: "erp", name: "milana-erp" };
const store = () => ({ mcp: { list: () => [SERVER], update: () => {} } });
const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function manager(script) {
  const calls = [];
  let live = true;
  return {
    calls,
    isLive: () => live,
    connect: async () => { live = true; calls.push("connect"); return { tools: [] }; },
    disconnect: async () => { live = false; calls.push("disconnect"); },
    callTool: async (_id, tool) => {
      calls.push(tool);
      const step = script.shift();
      if (step instanceof Error) throw step;
      return answer(step);
    },
  };
}

test("a timed-out call is retried once on a fresh bridge", async () => {
  const timeout = Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 });
  const mcp = manager([timeout, { ok: true, data: { total_pieces: 1129 } }]);
  const bridge = createErpBridge({ db: store(), mcpManager: mcp });
  const result = await bridge.call("erp_finished_goods_stock", { limit: 1 });
  assert.equal(result.data.total_pieces, 1129);
  assert.deepEqual(mcp.calls, ["erp_finished_goods_stock", "disconnect", "connect", "erp_finished_goods_stock"]);
});

test("a second timeout is reported, not retried forever", async () => {
  const timeout = () => Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 });
  const mcp = manager([timeout(), timeout()]);
  const bridge = createErpBridge({ db: store(), mcpManager: mcp });
  await assert.rejects(() => bridge.call("erp_late_orders"), /timed out/);
  assert.equal(mcp.calls.filter((call) => call === "erp_late_orders").length, 2);
  const safe = await createErpBridge({ db: store(), mcpManager: manager([timeout(), timeout()]) }).safeCall("erp_late_orders");
  assert.equal(safe.ok, false);
  assert.match(safe.error.message, /timed out/);
});

test("an ERP refusal comes back as itself — no reconnect, no retry", async () => {
  const mcp = manager([{ ok: false, error: { status_code: 403, message: "Forbidden" } }]);
  const bridge = createErpBridge({ db: store(), mcpManager: mcp });
  const result = await bridge.call("erp_finance_summary");
  assert.equal(result.ok, false);
  assert.equal(result.error.status_code, 403);
  assert.deepEqual(mcp.calls, ["erp_finance_summary"]);
});
