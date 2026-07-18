import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { hermesChatComplete, hermesChatStatus } from "../server/lib/hermes-chat.js";

test("Hermes text provider uses the private Unix bridge and parses completions", async () => {
  let request;
  const result = await hermesChatComplete([
    { role: "system", content: "Be concise" },
    { role: "user", content: "Hello" },
  ], { timeoutSeconds: 45 }, async (pathname, options) => {
    request = { pathname, options };
    return {
      status: 200,
      text: JSON.stringify({ model: "hermes/openai-codex", choices: [{ message: { content: "Hello from Hermes" } }] }),
    };
  });
  assert.equal(request.pathname, "/v1/chat/completions");
  assert.equal(request.options.method, "POST");
  assert.equal(JSON.parse(request.options.body).messages[1].content, "Hello");
  assert.equal(result.text, "Hello from Hermes");
  assert.equal(result.model, "hermes/openai-codex");
});

test("Hermes text provider health is bounded and reports bridge failures", async () => {
  const ready = await hermesChatStatus(async () => ({ status: 200, text: '{"ok":true,"provider":"hermes","mode":"safe"}' }));
  assert.equal(ready.ready, true);
  assert.equal(ready.mode, "safe");

  const failed = await hermesChatStatus(async () => { throw new Error("socket unavailable"); });
  assert.equal(failed.ready, false);
  assert.match(failed.error, /socket unavailable/);
});

test("Hermes text bridge is isolated, bounded and excludes terminal toolsets", () => {
  const bridge = fs.readFileSync(new URL("../scripts/hermes-chat-bridge.py", import.meta.url), "utf8");
  const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const llm = fs.readFileSync(new URL("../server/routes/llm.js", import.meta.url), "utf8");
  assert.match(bridge, /UnixStreamServer/);
  assert.match(bridge, /MAX_PROMPT_CHARS/);
  assert.match(bridge, /BoundedSemaphore/);
  assert.match(bridge, /"--safe-mode", "--toolsets", "safe"/);
  assert.doesNotMatch(bridge, /shell\s*=\s*True/);
  assert.match(compose, /HERMES_CHAT_SOCKET=\/run\/agentic-os\/hermes-chat\.sock/);
  assert.match(llm, /prov === "hermes"/);
});
