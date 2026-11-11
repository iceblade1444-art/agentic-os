import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("public health is minimal and database internals require a manager", () => {
  const publicHealth = server.slice(server.indexOf('app.get("/api/health"'), server.indexOf('app.post("/api/auth/login"'));
  assert.doesNotMatch(publicHealth, /database|outbox|authReads|sourceOfTruth/);
  assert.match(server, /app\.get\("\/api\/health\/details", requireOperator/);
  assert.match(api, /healthNow: \(\) => j\("\/api\/health\/details"\)/);
});

test("the application image exposes a real container health check", () => {
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*127\.0\.0\.1:8787\/api\/health/);
});
