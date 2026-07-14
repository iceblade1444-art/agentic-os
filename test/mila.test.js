import assert from "node:assert/strict";
import { test } from "node:test";

import { milaConnectionCode, milaStatus } from "../server/lib/mila.js";

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

test("MILA connector rejects unsafe URL schemes", async () => {
  await assert.rejects(
    milaStatus({ baseUrl: "file:///etc/passwd", adminToken: "secret" }),
    /HTTP\(S\)/,
  );
});
