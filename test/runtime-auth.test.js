// The Node → Python runtime hop had no credential at all: anything on the
// Compose network could reach approvals and the Hermes CLI. These tests cover
// the calling side; agentos-runtime/tests/test_runtime_auth.py covers the
// enforcing side.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { runtimeAuthConfigured, runtimeInternalHeaders } from "../server/lib/runtime-auth.js";

test("a configured token travels as a bearer credential", () => {
  assert.deepEqual(runtimeInternalHeaders({ Accept: "application/json" }, "s3cret"), {
    Accept: "application/json",
    Authorization: "Bearer s3cret",
  });
});

// The secret must be a parameter, not a module constant read at import time:
// that mistake made an earlier speech-header test pass only on machines whose
// .env happened to be empty.
test("no token means no invented credential", () => {
  assert.deepEqual(runtimeInternalHeaders({ Accept: "application/json" }, ""), { Accept: "application/json" });
  assert.deepEqual(runtimeInternalHeaders({}, ""), {});
  assert.equal(runtimeAuthConfigured(""), false);
  assert.equal(runtimeAuthConfigured("s3cret"), true);
});

test("the caller's own headers are never dropped or mutated", () => {
  const supplied = { "Content-Type": "application/json" };
  const headers = runtimeInternalHeaders(supplied, "s3cret");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(supplied, { "Content-Type": "application/json" }, "the input object stays untouched");
});

test("both runtime callers send the credential", () => {
  for (const file of ["../server/lib/orchestrator.js", "../server/lib/pulse.js"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /runtimeInternalHeaders\(/, `${file} must authenticate its runtime calls`);
  }
});

test("deploy generates the token and compose hands it to both containers", () => {
  const deploy = fs.readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /AGENTOS_RUNTIME_TOKEN=\$\{RUNTIME_TOKEN\}/);

  const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const wired = compose.match(/AGENTOS_RUNTIME_TOKEN=\$\{AGENTOS_RUNTIME_TOKEN:-\}/g) || [];
  assert.equal(wired.length, 2, "the API and the runtime both need the shared secret");
});

test("the container's own health probe carries the credential too", () => {
  // Every caller was given the token except the one Docker uses. The probe
  // kept asking anonymously, the runtime kept answering 401, and the container
  // reported unhealthy for three days while serving every real request
  // correctly — a smoke alarm going off continuously, which is worse than none,
  // because nobody looks when it finally means something.
  const dockerfile = fs.readFileSync(new URL("../agentos-runtime/Dockerfile", import.meta.url), "utf8");
  const at = dockerfile.indexOf("HEALTHCHECK");
  assert.notEqual(at, -1, "the runtime image has no health probe");
  const probe = dockerfile.slice(at, dockerfile.indexOf("\nCMD ", at));
  assert.match(probe, /AGENTOS_RUNTIME_TOKEN/, "the probe must read the token");
  assert.match(probe, /Authorization/, "and send it as a bearer credential");
  // Absent token means a local run, which the runtime still answers.
  assert.match(probe, /if t else \{\}/, "no token, no header — a local run must still pass");
});
