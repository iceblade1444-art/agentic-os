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

test("a lost connection is asked again; a refusal is reported as itself", async () => {
  const { createErpBridge } = await import("../server/lib/erp-bridge.js");
  const harness = (replies) => {
    const seen = [];
    const bridge = createErpBridge({
      db: { mcp: { list: () => [{ id: "mcp_erp", kind: "erp" }], update: () => {} } },
      mcpManager: {
        isLive: () => true, connect: async () => ({ tools: [] }), disconnect: async () => {},
        callTool: async () => { seen.push("call"); return { content: [{ type: "text", text: JSON.stringify(replies[seen.length - 1] ?? replies.at(-1)) }] }; },
      },
    });
    return { bridge, seen };
  };

  // The exact payload a failed DNS lookup produced while the ERP was serving
  // the page: MILA said the report was unavailable, and it was not.
  const blip = { ok: false, error: { status_code: 502, message: "ERP login request failed", path: "/api/auth/login" } };
  const good = { ok: true, data: { orders: [] } };
  const flaky = harness([blip, good]);
  assert.deepEqual(await flaky.bridge.call("erp_process_tracking", {}), good);
  assert.equal(flaky.seen.length, 2, "the blip is asked again");

  // A missing permission is the ERP answering, not the network failing.
  const denied = { ok: false, error: { status_code: 403, message: "Missing permission. Need any of: ['attendance.view']" } };
  const refused = harness([denied]);
  assert.deepEqual(await refused.bridge.call("erp_attendance_overview", {}), denied);
  assert.equal(refused.seen.length, 1, "a refusal is not retried");

  // Twice unreachable is an outage: report it, do not spin.
  const down = harness([blip, blip]);
  assert.deepEqual(await down.bridge.call("erp_process_tracking", {}), blip);
  assert.equal(down.seen.length, 2);
});

test("the sewing report reaches the model as totals, not as rows to sum", async () => {
  const { createMilaActions } = await import("../server/lib/mila-actions.js");
  const rows = [];
  // Six lines, several models each — the real shape that overflowed a text
  // tool result and cost the owner three quarters of the day's output.
  const plan = [["SEW-06", "Botirova Shaxnoza", [938, 312, 58]], ["SEW-07", "Jalolova Nargiza", [930]],
    ["SEW-09", "Akbarova Dilafruz", [1575]], ["SEW-10", "Maxmudova Nargiza - 1", [471]],
    ["SEW-12", "Botirova Muxlisa", [700]], ["SEW-13", "Maxmudova Nargiza - 2", [300]]];
  for (const [code, name, quantities] of plan) {
    for (const quantity of quantities) {
      rows.push({ line_code: code, line_name: name, sewn_qty: quantity, defective_qty: 0, model_no: `M-${quantity}`, filler: "x".repeat(600) });
    }
  }
  const actions = createMilaActions({
    erpBridge: {
      available: () => true,
      call: async () => ({ ok: true, data: {
        report_date: "2026-08-14", factory_code: "MIL",
        reports: { rows, total_sewn_qty: 5284, total_defective_qty: 0 },
        flows: [{ code: "SEW-06", capacity_per_day: 200 }],
      } }),
    },
    journal: { append: async () => null, recentText: () => "" },
    onboarding: { get: () => ({ profile: {} }) },
    db: { mcp: { list: () => [], update: () => {} } },
  });

  const result = await actions.call("get_sewing_daily_report", {}, { actor: "Бахадыр", user: { id: "creator", name: "Бахадыр", role: "Creator" } });
  assert.equal(result.sewing.total_sewn, 5284);
  assert.equal(result.sewing.lines_reported, 6);
  assert.equal(result.sewing.lines[0].code, "SEW-09", "lines come sorted by output");
  assert.equal(result.sewing.lines.find((line) => line.code === "SEW-06").sewn, 1308);
  assert.match(result.sewing.answer_summary, /5284 шт по 6 линиям/);
  // The whole point: the compact result survives the 4000-character tool clamp.
  assert.ok(JSON.stringify(result).length < 4000, `result is ${JSON.stringify(result).length} chars`);
});
