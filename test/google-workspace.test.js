import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Personal Google Workspace uses per-user PKCE and encrypted least-privilege tokens", () => {
  const connector = fs.readFileSync(new URL("../server/lib/google-workspace.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/personal.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/personal.js", import.meta.url), "utf8");

  assert.match(connector, /calendar\.readonly/);
  assert.match(connector, /gmail\.readonly/);
  assert.match(connector, /code_challenge_method: "S256"/);
  assert.match(connector, /aes-256-gcm/);
  assert.doesNotMatch(route, /refresh_token|access_token|clientSecret/);
  assert.match(route, /\/google\/callback/);
  assert.match(page, /data-google-connect/);
});
