import assert from "node:assert/strict";
import test from "node:test";

import {
  higgsfieldEnabled, higgsfieldImageModels, pollRequest, submitImage,
} from "../server/lib/higgsfield.js";

const cfg = (overrides = {}) => ({
  apiKey: "key", apiSecret: "secret", baseUrl: "https://platform.example", imageModels: "", ...overrides,
});

const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test("Higgsfield direct mode requires both API credentials", () => {
  assert.equal(higgsfieldEnabled(cfg()), true);
  assert.equal(higgsfieldEnabled(cfg({ apiSecret: "" })), false);
  assert.equal(higgsfieldEnabled(cfg({ apiKey: "" })), false);
});

test("image model list parses configured pairs and falls back to defaults", () => {
  const parsed = higgsfieldImageModels(cfg({ imageModels: "a/model|Label A, b/model ,|broken" }));
  assert.deepEqual(parsed, [{ id: "a/model", label: "Label A" }, { id: "b/model", label: "b/model" }]);
  const defaults = higgsfieldImageModels(cfg());
  assert.equal(defaults[0].id, "higgsfield-ai/soul/standard");
});

test("submitImage posts to the model endpoint with Key auth and returns the request id", async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ request_id: "req_1", status: "queued" });
  };
  const result = await submitImage(
    { model: "reve/text-to-image", prompt: "a coat", aspectRatio: "4:5", quality: "1080p" },
    cfg(), fetchStub,
  );
  assert.deepEqual(result, { requestId: "req_1", model: "reve/text-to-image" });
  assert.equal(calls[0].url, "https://platform.example/reve/text-to-image");
  assert.equal(calls[0].options.headers.Authorization, "Key key:secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { prompt: "a coat", aspect_ratio: "4:5", resolution: "1080p" });
});

test("submitImage falls back to the first known model for unknown ids", async () => {
  const fetchStub = async (url) => {
    assert.equal(url, "https://platform.example/higgsfield-ai/soul/standard");
    return jsonResponse({ request_id: "req_2" });
  };
  const result = await submitImage({ model: "made/up", prompt: "x" }, cfg(), fetchStub);
  assert.equal(result.model, "higgsfield-ai/soul/standard");
});

test("submitImage without credentials fails with a 503 without calling the API", async () => {
  await assert.rejects(
    () => submitImage({ prompt: "x" }, cfg({ apiKey: "" }), async () => { throw new Error("must not be called"); }),
    (error) => error.status === 503 && error.code === "higgsfield_disabled",
  );
});

test("pollRequest reports progress, completion, and failure states", async () => {
  const running = await pollRequest("req_1", cfg(), async () => jsonResponse({ status: "in_progress" }));
  assert.deepEqual(running, { status: "in_progress", done: false, failed: false, outputUrl: "", images: [], error: "" });

  const done = await pollRequest("req_1", cfg(), async () =>
    jsonResponse({ status: "completed", images: [{ url: "https://cdn.example/a.png" }, { url: "https://cdn.example/b.png" }] }));
  assert.equal(done.done, true);
  assert.equal(done.outputUrl, "https://cdn.example/a.png");
  assert.deepEqual(done.images, ["https://cdn.example/a.png", "https://cdn.example/b.png"]);

  const failed = await pollRequest("req_1", cfg(), async () => jsonResponse({ status: "nsfw" }));
  assert.equal(failed.failed, true);
  assert.match(failed.error, /nsfw/);
});

test("API errors surface the upstream detail as a 502", async () => {
  await assert.rejects(
    () => pollRequest("req_1", cfg(), async () => jsonResponse({ detail: "Out of credits" }, false, 402)),
    (error) => error.status === 502 && /Out of credits/.test(error.message),
  );
});
