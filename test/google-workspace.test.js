import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Personal Google Workspace uses per-user PKCE and encrypted least-privilege tokens", () => {
  const connector = fs.readFileSync(new URL("../server/lib/google-workspace.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/personal.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/personal.js", import.meta.url), "utf8");

  assert.match(connector, /calendar\.readonly/);
  assert.doesNotMatch(connector, /gmail\.readonly/);
  assert.match(connector, /code_challenge_method: "S256"/);
  assert.match(connector, /aes-256-gcm/);
  assert.match(connector, /grant_type: "refresh_token"/);
  assert.match(connector, /calendarEvents/);
  assert.doesNotMatch(route, /refresh_token|access_token|clientSecret/);
  assert.match(route, /\/google\/calendar\/events/);
  assert.doesNotMatch(route, /\/google\/callback/);
  assert.ok(
    server.indexOf('app.get("/api/personal/google/callback"') <
      server.indexOf('app.use("/api", requireAuth)'),
    "OAuth callback must be reachable from the phone system browser",
  );
  assert.match(page, /data-google-connect/);
  assert.match(page, /googleEvents/);
});
