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

test("speech proxy does not invent an internal credential", () => {
  assert.deepEqual(speechInternalHeaders({ "Content-Type": "audio/webm" }), {
    "Content-Type": "audio/webm",
  });
});

test("speech service is reproducible without committing model weights", () => {
  const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const ignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../speech-service/Dockerfile", import.meta.url), "utf8");
  assert.match(compose, /context: \.\/speech-service/);
  assert.match(compose, /SPEECH_INTERNAL_SECRET/);
  assert.match(ignore, /speech-models\//);
  assert.match(dockerfile, /uvicorn/);
  assert.doesNotMatch(dockerfile, /COPY\s+.*models/i);
});
