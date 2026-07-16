import assert from "node:assert/strict";
import { test } from "node:test";

import { milaConnectionCode, milaStatus, milaVoiceToken } from "../server/lib/mila.js";

test("MILA status uses the server-held admin token", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, voiceConfigured: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const status = await milaStatus(
    { baseUrl: "http://mila.internal:8791/", adminToken: "server-secret" },
    { fetchImpl },
  );

  assert.equal(status.voiceConfigured, true);
  assert.equal(request.url, "http://mila.internal:8791/admin/status");
  assert.equal(request.options.headers["X-Admin-Token"], "server-secret");
});

test("MILA connection code forwards only the requested account label", async () => {
  const fetchImpl = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { label: "Mobile user" });
    return new Response(JSON.stringify({ ok: true, code: "AB12CD34" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await milaConnectionCode(
    { baseUrl: "https://mila.example", adminToken: "server-secret" },
    "Mobile user",
    { fetchImpl },
  );
  assert.equal(result.code, "AB12CD34");
});

test("MILA voice token exchange keeps long-lived credentials server-side", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const data = url.endsWith("/admin/connection-code")
      ? { code: "VOICE123" }
      : url.endsWith("/v1/auth/device")
        ? { token: "dashboard-session-secret" }
        : { token: "short-lived-live-token", expiresAt: "2026-07-16T12:00:00Z" };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await milaVoiceToken(
    { baseUrl: "https://mila.example", adminToken: "admin-secret" },
    "Dashboard",
    { fetchImpl },
  );

  assert.deepEqual(result, {
    token: "short-lived-live-token",
    expiresAt: "2026-07-16T12:00:00Z",
    newSessionExpiresAt: null,
  });
  assert.deepEqual(requests.map((request) => request.url), [
    "https://mila.example/admin/connection-code",
    "https://mila.example/v1/auth/device",
    "https://mila.example/v1/voice/token",
  ]);
  assert.equal(requests[0].options.headers["X-Admin-Token"], "admin-secret");
  assert.deepEqual(JSON.parse(requests[1].options.body), { code: "VOICE123" });
  assert.equal(requests[2].options.headers.Authorization, "Bearer dashboard-session-secret");
  assert.equal(JSON.stringify(result).includes("admin-secret"), false);
  assert.equal(JSON.stringify(result).includes("dashboard-session-secret"), false);

  await milaVoiceToken(
    { baseUrl: "https://mila.example", adminToken: "admin-secret" },
    "Dashboard",
    { fetchImpl },
  );
  assert.equal(requests.length, 4);
  assert.equal(requests[3].url, "https://mila.example/v1/voice/token");
  assert.equal(requests[3].options.headers.Authorization, "Bearer dashboard-session-secret");
});

test("MILA connector rejects unsafe URL schemes", async () => {
  await assert.rejects(
    milaStatus({ baseUrl: "file:///etc/passwd", adminToken: "secret" }),
    /HTTP\(S\)/,
  );
});
