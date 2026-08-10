import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Personal Google Workspace uses per-user PKCE and encrypted least-privilege tokens", () => {
  const connector = fs.readFileSync(new URL("../server/lib/google-workspace.js", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../server/routes/personal.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/personal.js", import.meta.url), "utf8");

  // MILA schedules the day, so the grant covers the user's own events — and stops
  // there: not the full calendar scope, and no mail.
  assert.match(connector, /const SCOPES = \[\s*"https:\/\/www\.googleapis\.com\/auth\/calendar\.events",\s*\]/);
  assert.doesNotMatch(connector, /gmail\.readonly/);
  assert.match(connector, /code_challenge_method: "S256"/);
  assert.match(connector, /aes-256-gcm/);
  assert.match(connector, /grant_type: "refresh_token"/);
  assert.match(connector, /calendarEvents/);
  // A grant made before writes existed keeps working read-only and says so, rather
  // than failing an event creation with an opaque Google error.
  assert.match(connector, /scopeStale/);
  assert.match(connector, /function requireWrite/);
  for (const method of ["createEvent", "updateEvent", "deleteEvent"]) {
    assert.match(connector, new RegExp(`async ${method}\\(`), `${method} must exist`);
  }
  assert.doesNotMatch(route, /refresh_token|access_token|clientSecret/);
  assert.match(route, /\/google\/calendar\/events/);
  assert.doesNotMatch(route, /\/google\/callback/);
  assert.ok(
    server.indexOf('app.get("/api/personal/google/callback"') <
      server.indexOf('app.use("/api", requireAuth)'),
    "OAuth callback must be reachable from the phone system browser",
  );
  assert.match(page, /data-google-connect/);
  // The page reads the assembled day plan, which already carries calendar events,
  // instead of fetching the raw event list a second time.
  assert.match(page, /api\.personal\.plan\(/);
});
