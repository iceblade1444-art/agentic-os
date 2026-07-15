import assert from "node:assert/strict";
import { test } from "node:test";

import { runMission } from "../server/lib/orchestrator.js";


test("public missions delegate to Hermes AgentOS runtime", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/orchestrator/status")) {
      return new Response(JSON.stringify({
        ready: true,
        version: "Hermes Agent v0.18.2",
        profile: "default",
        provider: "openai-codex",
        model: "gpt-5.5",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      created: {
        slug: "test-mission",
        tasks: 2,
        approvals: [],
        orchestrator: { plan_source: "hermes_cli", plan_summary: "Validated plan" },
      },
      run: { status: "executed", executed_count: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const events = [];
  try {
    await runMission({ title: "Test", goal: "Verify Hermes bridge" }, (event) => events.push(event));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/api\/orchestrator\/status$/);
  assert.match(requests[1].url, /\/api\/orchestrator\/create-and-run$/);
  assert.equal(JSON.parse(requests[1].options.body).goal, "Verify Hermes bridge");
  assert.equal(events.at(-1).type, "complete");
  assert.equal(events.at(-1).status, "completed");
  assert.ok(events.some((event) => event.message.includes("Hermes created 2")));
});


test("public mission remains waiting when Hermes creates an approval gate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = url.endsWith("/api/orchestrator/status")
      ? { ready: true, profile: "default", model: "gpt-5.5" }
      : {
          created: { slug: "risky", tasks: 2, approvals: [{ id: "approval_1" }], orchestrator: {} },
          run: { status: "waiting_for_human_gate", executed_count: 1 },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const events = [];
  try {
    await runMission({ title: "Deploy" }, (event) => events.push(event));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(events.at(-1).type, "approval_required");
  assert.equal(events.at(-1).status, "waiting_for_approval");
});
