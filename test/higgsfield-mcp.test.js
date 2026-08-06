import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Higgsfield MCP OAuth provider persists and invalidates credentials in DATA_DIR", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-hf-mcp-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;

  const { oauthProvider, higgsfieldMcpAuthorized } = await import(`../server/lib/higgsfield-mcp.js?store=${Date.now()}`);

  assert.equal(higgsfieldMcpAuthorized(), false);
  assert.equal(oauthProvider.tokens(), undefined);
  assert.match(oauthProvider.redirectUrl, /\/api\/studio\/higgsfield\/oauth\/callback$/);
  assert.deepEqual(oauthProvider.clientMetadata.redirect_uris, [oauthProvider.redirectUrl]);
  assert.equal(oauthProvider.clientMetadata.token_endpoint_auth_method, "none");

  oauthProvider.saveClientInformation({ client_id: "client_1" });
  oauthProvider.saveCodeVerifier("verifier_1");
  oauthProvider.saveTokens({ access_token: "at_1", token_type: "Bearer" });

  assert.equal(higgsfieldMcpAuthorized(), true);
  assert.equal(oauthProvider.clientInformation().client_id, "client_1");
  assert.equal(oauthProvider.codeVerifier(), "verifier_1");
  assert.equal(oauthProvider.tokens().access_token, "at_1");
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "higgsfield-mcp.json"), "utf8"));
  assert.equal(persisted.tokens.access_token, "at_1");

  oauthProvider.invalidateCredentials("tokens");
  assert.equal(higgsfieldMcpAuthorized(), false);
  assert.equal(oauthProvider.clientInformation().client_id, "client_1");
  oauthProvider.invalidateCredentials("all");
  assert.equal(oauthProvider.clientInformation(), undefined);
  assert.equal(oauthProvider.codeVerifier(), "");
});

test("Higgsfield MCP result parsing extracts job ids, media URLs, and states", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-hf-parse-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;

  const { contentText, extractJobIds, extractMediaUrls } = await import(`../server/lib/higgsfield-mcp.js?parse=${Date.now()}`);

  const text = contentText({
    content: [
      { type: "text", text: "Job submitted: 8a5ff979-f5f2-4c1e-8e89-de563a8b50ec (queued)" },
      { type: "text", text: "Track it at https://mcp.higgsfield.ai/requests/x" },
    ],
  });
  assert.deepEqual(extractJobIds(text), ["8a5ff979-f5f2-4c1e-8e89-de563a8b50ec"]);
  assert.deepEqual(extractMediaUrls(text), []);

  const done = "index 0: completed — https://cdn.higgsfield.ai/media/result-1.png, https://cdn.higgsfield.ai/media/result-2.png.";
  assert.deepEqual(extractMediaUrls(done), [
    "https://cdn.higgsfield.ai/media/result-1.png",
    "https://cdn.higgsfield.ai/media/result-2.png",
  ]);
  assert.equal(contentText({}), "");
  assert.equal(contentText({ content: [{ type: "image" }] }), "");
});

test("studio routes expose the Higgsfield OAuth endpoints and mode-aware run path", () => {
  const route = fs.readFileSync(new URL("../server/routes/studio.js", import.meta.url), "utf8");
  assert.match(route, /higgsfield\/connect/);
  assert.match(route, /higgsfield\/oauth\/callback/);
  assert.match(route, /higgsfield\/logout/);
  assert.match(route, /mcpGenerateImage/);
  assert.match(route, /mcpPollJob/);
  assert.match(route, /higgsfieldMode\(\)/);
});
