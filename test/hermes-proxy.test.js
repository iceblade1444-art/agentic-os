import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hermesDashboardStatus,
  hermesForwardedHeaders,
  isBareHermesRequest,
  stripHermesPrefix,
} from "../server/lib/hermes-proxy.js";

test("Hermes proxy strips only its mounted prefix", () => {
  assert.equal(stripHermesPrefix("/hermes"), "/");
  assert.equal(stripHermesPrefix("/hermes/"), "/");
  assert.equal(stripHermesPrefix("/hermes/api/status?profile=default"), "/api/status?profile=default");
  assert.equal(stripHermesPrefix("/hermes-chat"), "/hermes-chat");
});

test("Hermes root redirect does not loop on the slash route", () => {
  assert.equal(isBareHermesRequest("GET", "/hermes"), true);
  assert.equal(isBareHermesRequest("GET", "/hermes?profile=default"), true);
  assert.equal(isBareHermesRequest("GET", "/hermes/"), false);
  assert.equal(isBareHermesRequest("POST", "/hermes"), false);
});

test("Hermes proxy preserves public callback headers and normalizes its private origin", () => {
  const headers = hermesForwardedHeaders({ headers: {
    host: "agent.milanapremium.uz",
    "x-forwarded-proto": "https",
    origin: "https://agent.milanapremium.uz",
  } });
  assert.deepEqual(headers, {
    proto: "https",
    host: "agent.milanapremium.uz",
    origin: "http://127.0.0.1:9119",
  });
});

test("Hermes control status treats login redirects as a ready dashboard", async () => {
  const calls = [];
  const result = await hermesDashboardStatus(async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 302, headers: { Location: "/login" } });
  }, { socketPath: "", dashboardUrl: "http://hermes.test:9119" });

  assert.equal(result.ready, true);
  assert.equal(result.status, 302);
  assert.equal(result.url, "/hermes/");
  assert.equal(calls[0].options.redirect, "manual");
});

test("Hermes control status returns a bounded unavailable result", async () => {
  const result = await hermesDashboardStatus(async () => {
    throw new Error("connection refused");
  }, { socketPath: "", dashboardUrl: "http://hermes.test:9119" });

  assert.equal(result.ready, false);
  assert.equal(result.status, 0);
  assert.match(result.error, /connection refused/);
});

test("Hermes Control stays in the existing Agentic OS visual shell", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../assets/js/pages/hermes.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../assets/css/styles.css", import.meta.url), "utf8");

  assert.match(app, /route: "hermes"/);
  assert.match(page, /class="hermes-frame"/);
  assert.match(page, /src="\/hermes\/"/);
  assert.match(css, /\.hermes-frame-shell/);
});
