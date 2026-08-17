import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("ATLAS is registered as an operator test application", () => {
  const app = read("assets/js/app.js");
  const page = read("assets/js/pages/test-apps.js");
  assert.match(app, /route: "test-apps"/);
  assert.match(app, /"test-apps": testApps/);
  assert.match(page, /atlas-academy-0\.1\.0\.apk/);
  assert.match(page, /\/atlas-api\/health/);
});

test("ATLAS proxy and release volume are deployment-configured", () => {
  const server = read("server/index.js");
  const compose = read("docker-compose.yml");
  assert.match(server, /mountAtlasProxy\(app\)/);
  assert.match(server, /\/atlas-downloads/);
  assert.match(compose, /ATLAS_API_URL/);
  assert.match(compose, /atlas-releases:\/app\/atlas-releases:ro/);
});

