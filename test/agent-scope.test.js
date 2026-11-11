import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { agentSessionToken, creatorUser, requireAuth, requireRoles } from "../server/lib/auth.js";

test("agent credentials cannot become operator API credentials, including inside mounted routers", async () => {
  const app = express();
  app.use("/api", requireAuth);
  const router = express.Router();
  router.use(requireRoles("Creator"));
  router.all("/*", (_req, res) => res.json({ reached: true }));
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const channel of ["mobile", "telegram", "messenger"]) {
      const headers = { authorization: `Bearer ${agentSessionToken(creatorUser(), channel)}` };
      for (const [method, route, expected] of [
        ["GET", "/api/erp?refresh=1", 200], ["POST", "/api/mila/actions", 200],
        ["GET", "/api/secrets", 403], ["POST", "/api/mcp/call", 403],
        ["POST", "/api/erp/wiki-sync", 403], ["DELETE", "/api/mila/actions", 403],
      ]) {
        const response = await fetch(base + route, { method, headers });
        assert.equal(response.status, expected, `${channel}: ${method} ${route}`);
        await response.body.cancel();
      }
    }
    const response = await fetch(base + "/api/erp", { headers: { authorization: `Bearer ${agentSessionToken(creatorUser(), "app")}` } });
    assert.equal(response.status, 403);
    await response.body.cancel();
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
