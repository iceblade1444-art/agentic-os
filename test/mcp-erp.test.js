import assert from "node:assert/strict";
import test from "node:test";

import { resolveSpawn } from "../server/mcp/manager.js";
import { db } from "../server/store.js";

test("Milana ERP is seeded as a built-in MCP server", () => {
  const erp = db.mcp.get("mcp_erp");
  assert.equal(erp.kind, "erp");
  assert.equal(erp.name, "milana-erp");
});

test("Milana ERP MCP resolves to the bundled bridge with safe environment", () => {
  const spec = resolveSpawn({ id: "mcp_erp", kind: "erp" });
  assert.equal(spec.command, process.execPath);
  assert.match(spec.args[0], /erp-server\.js$/);
  assert.equal(spec.env.ERP_API_BASE_URL.includes("erp.milanapremium.uz"), true);
  assert.equal(spec.env.ERP_MCP_REQUIRE_CONFIRMATION, "true");
  assert.ok(Number(spec.env.ERP_MCP_MAX_BULK_RECIPIENTS) >= 1);
  assert.equal("ERP_MCP_BEARER_TOKEN" in spec.env, true);
});
