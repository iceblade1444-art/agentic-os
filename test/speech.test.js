import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { safeSpeechFilename, speechInternalHeaders } from "../server/routes/speech.js";

test("speech upload filenames are bounded to a safe basename", () => {
  assert.equal(safeSpeechFilename(encodeURIComponent("../../voice sample.webm")), "voice sample.webm");
  assert.equal(safeSpeechFilename("%E0%A4%A"), "audio.webm");
  assert.equal(safeSpeechFilename(".hidden"), "hidden");
  assert.equal(safeSpeechFilename("a".repeat(260) + ".wav").length, 200);
});

test("speech proxy sends the internal credential only when one is configured", () => {
  // Passing the secret in keeps this independent of the ambient environment:
  // reading it from process.env made the suite pass locally and fail on the
  // server, where .env defines SPEECH_INTERNAL_SECRET.
  for (const missing of ["", undefined, null]) {
    assert.deepEqual(
      speechInternalHeaders({ "Content-Type": "audio/webm" }, missing),
      { "Content-Type": "audio/webm" },
      "no secret configured means no credential header is invented",
    );
  }
  assert.deepEqual(speechInternalHeaders({ "Content-Type": "audio/webm" }, "s3cret"), {
    "Content-Type": "audio/webm",
    "X-Internal-Secret": "s3cret",
  });
  // The helper adds exactly one header and never rewrites what it was given.
  const extra = { "Content-Type": "audio/wav", "X-Other": "keep" };
  assert.deepEqual(speechInternalHeaders(extra, "s3cret"), { ...extra, "X-Internal-Secret": "s3cret" });
  assert.deepEqual(extra, { "Content-Type": "audio/wav", "X-Other": "keep" }, "the input must not be mutated");
});

test("speech service is reproducible without committing model weights", () => {
  const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const ignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../speech-service/Dockerfile", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/speech.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/speech.js", import.meta.url), "utf8");
  assert.match(compose, /context: \.\/speech-service/);
  assert.match(compose, /SPEECH_INTERNAL_SECRET/);
  assert.match(ignore, /speech-models\//);
  assert.match(dockerfile, /uvicorn/);
  assert.doesNotMatch(dockerfile, /COPY\s+.*models/i);
  assert.match(route, /voice owner consent is required/);
  assert.match(page, /cloneConsent/);
});
