import assert from "node:assert/strict";
import test from "node:test";

import { resolveSpawn } from "../server/mcp/manager.js";
import { db } from "../server/store.js";

test("Milana ERP is seeded as a built-in MCP server", () => {
  const erp = db.mcp.get("mcp_erp");
  assert.equal(erp.kind, "erp");
  assert.equal(erp.name, "milana-erp");
});

// The spawn config is passed in rather than read from the ambient environment.
// Asserting the bundled bridge unconditionally passed on a developer machine and
// failed on the server, where ERP_MCP_PYTHON_MODULE selects the Python bridge.
const erpConfig = (overrides = {}) => ({
  baseUrl: "https://erp.milanapremium.uz",
  bearerToken: "token",
  username: "",
  password: "",
  authMode: "bearer",
  requireConfirmation: true,
  maxBulkRecipients: 25,
  command: "",
  args: "",
  pythonModule: "",
  ...overrides,
});

test("Milana ERP MCP falls back to the bundled Node bridge", () => {
  const spec = resolveSpawn({ id: "mcp_erp", kind: "erp" }, erpConfig());
  assert.equal(spec.command, process.execPath);
  assert.match(spec.args[0], /erp-server\.js$/);
});

test("a configured Python module or command wins over the bundled bridge", () => {
  const python = resolveSpawn(
    { id: "mcp_erp", kind: "erp" },
    erpConfig({ pythonModule: "milana_erp_mcp", args: "--verbose" }),
  );
  assert.match(python.command, /python3?$|python\.exe$/i);
  assert.deepEqual(python.args, ["-m", "milana_erp_mcp", "--verbose"]);

  // An explicit command with a Python module still spawns that interpreter.
  const pinned = resolveSpawn(
    { id: "mcp_erp", kind: "erp" },
    erpConfig({ pythonModule: "milana_erp_mcp", command: "/usr/bin/python3.12" }),
  );
  assert.equal(pinned.command, "/usr/bin/python3.12");

  // A bare command without a module is spawned as given.
  const bare = resolveSpawn({ id: "mcp_erp", kind: "erp" }, erpConfig({ command: "/opt/erp/bridge" }));
  assert.equal(bare.command, "/opt/erp/bridge");
  assert.deepEqual(bare.args, []);
});

test("every ERP spawn carries the same safe environment", () => {
  for (const overrides of [{}, { pythonModule: "milana_erp_mcp" }, { command: "/opt/erp/bridge" }]) {
    const { env } = resolveSpawn({ id: "mcp_erp", kind: "erp" }, erpConfig(overrides));
    assert.equal(env.ERP_API_BASE_URL.includes("erp.milanapremium.uz"), true);
    assert.equal(env.ERP_MCP_REQUIRE_CONFIRMATION, "true");
    assert.ok(Number(env.ERP_MCP_MAX_BULK_RECIPIENTS) >= 1);
    assert.equal("ERP_MCP_BEARER_TOKEN" in env, true);
  }
});
