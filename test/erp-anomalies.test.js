// A sharp ERP move is said the day it happens — once, and never from missing data.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createErpAnomalies } from "../server/lib/erp-anomalies.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };

function fixture({ sequence }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-anomaly-"));
  const inbox = [];
  let step = 0;
  let when = new Date("2026-08-14T05:00:00.000Z");
  const instance = createErpAnomalies({
    file: path.join(dir, "state.json"),
    erpDigest: { read: async () => sequence[Math.min(step++, sequence.length - 1)] },
    pushService: { sendInbox: async (userId, item) => { inbox.push({ userId, item }); return {}; } },
    onboarding: { get: () => ({ profile: { timezone: "Asia/Tashkent" } }) },
    creatorUser: () => OWNER,
    now: () => when,
  });
  return { instance, inbox, setWhen: (value) => { when = new Date(value); }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const DAY = (late, goods) => ({ available: true, lateOrders: late, finishedGoodsPieces: goods, lateOrdersDetail: "" });

test("a jump in late orders and a stock drop alert once against yesterday", async () => {
  const f = fixture({ sequence: [DAY(2, 10000), DAY(6, 7500), DAY(6, 7500), DAY(6, 7500)] });
  assert.equal((await f.instance.tick()).length, 0, "day one only sets the baseline");

  f.setWhen("2026-08-15T05:00:00.000Z");
  const alerts = await f.instance.tick();
  assert.equal(alerts.length, 2);
  assert.match(f.inbox[0].item.body, /стало 6 — было 2 вчера/);
  assert.match(f.inbox[1].item.body, /Осталось 7500 шт — вчера было 10000/);

  // Same day, still bad — no repeat every half hour.
  assert.equal((await f.instance.tick()).length, 0);
  assert.equal(f.inbox.length, 2);
  f.cleanup();
});

test("small moves and missing data stay silent", async () => {
  const f = fixture({ sequence: [DAY(4, 10000), DAY(5, 9000), DAY(null, null)] });
  await f.instance.tick();
  f.setWhen("2026-08-15T05:00:00.000Z");
  assert.equal((await f.instance.tick()).length, 0, "+1 late order and -10% stock are noise, not anomalies");
  f.setWhen("2026-08-16T05:00:00.000Z");
  assert.equal((await f.instance.tick()).length, 0, "missing data can neither trigger nor clear");
  f.cleanup();
});

test("a dead MCP pipe is retried once on a fresh connection; real errors are not", async () => {
  const { createErpBridge } = await import("../server/lib/erp-bridge.js");
  const calls = [];
  let first = true;
  const bridge = createErpBridge({
    db: { mcp: { list: () => [{ id: "mcp_erp", kind: "erp" }], update: () => {} } },
    mcpManager: {
      isLive: () => true,
      connect: async () => ({ tools: [] }),
      disconnect: async () => calls.push("disconnect"),
      callTool: async () => {
        calls.push("call");
        if (first) { first = false; throw new Error("MCP error -32000: Connection closed"); }
        return { content: [{ type: "text", text: '{"ok":true,"data":1}' }] };
      },
    },
  });
  // The deploy window: the held pipe died, the retry answers.
  const result = await bridge.call("erp_late_orders", {});
  assert.deepEqual(result, { ok: true, data: 1 });
  assert.deepEqual(calls, ["call", "disconnect", "call"]);

  // A real error is itself, once — no blind retry loop.
  const failing = createErpBridge({
    db: { mcp: { list: () => [{ id: "mcp_erp", kind: "erp" }], update: () => {} } },
    mcpManager: {
      isLive: () => true, connect: async () => ({ tools: [] }), disconnect: async () => {},
      callTool: async () => { throw new Error("Unknown tool erp_nonsense"); },
    },
  });
  await assert.rejects(failing.call("erp_nonsense", {}), /Unknown tool/);
});
