// The /dsh mount: DeepSeek Harness's root-assuming UI stays under the
// operator-authenticated prefix, and its loopback-only trust fence keeps
// being satisfied by the proxy, not bypassed by it.

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import express from "express";

import {
  createDshProxy,
  dshStatus,
  isBareDshRequest,
  mountDshProxy,
  rewriteDshAsset,
  rewriteDshHtml,
  stripDshPrefix,
} from "../server/lib/dsh-proxy.js";

test("dsh proxy strips only its mounted prefix", () => {
  assert.equal(stripDshPrefix("/dsh"), "/");
  assert.equal(stripDshPrefix("/dsh/"), "/");
  assert.equal(stripDshPrefix("/dsh/api/events.mux?session=1"), "/api/events.mux?session=1");
  assert.equal(stripDshPrefix("/dsh-other"), "/dsh-other");
});

test("dsh root redirect does not loop on the slash route", () => {
  assert.equal(isBareDshRequest("GET", "/dsh"), true);
  assert.equal(isBareDshRequest("GET", "/dsh?x=1"), true);
  assert.equal(isBareDshRequest("GET", "/dsh/"), false);
  assert.equal(isBareDshRequest("POST", "/dsh"), false);
});

test("the boot manifest's JSON plugin urls move under the mount", () => {
  // The exact shape dsh serves: absolute urls inside an inline JSON script.
  const html = '<script>window.__DSH_BOOT__ = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-api-gateway/client.js?rev=9e83"}]}</script>'
    + '<link rel="icon" href="/favicon.svg" /><script type="module" src="/assets/index-C1.js"></script>';
  const rewritten = rewriteDshHtml(html);
  assert.match(rewritten, /"\/dsh\/plugins\/@deepseek-ai\/dsh-api-gateway\/client\.js\?rev=9e83"/);
  assert.match(rewritten, /href="\/dsh\/favicon\.svg"/);
  assert.match(rewritten, /src="\/dsh\/assets\/index-C1\.js"/);
});

test("hardcoded api endpoints in client bundles move under the mount", () => {
  // The connection plugin ships these exact literals.
  const js = 'const a = "/api/events.mux"; const b = "/api/events.host"; const c = "/api/respond"; const d = "/api";';
  const rewritten = rewriteDshAsset(js);
  assert.match(rewritten, /"\/dsh\/api\/events\.mux"/);
  assert.match(rewritten, /"\/dsh\/api\/events\.host"/);
  assert.match(rewritten, /"\/dsh\/api\/respond"/);
  assert.match(rewritten, /"\/dsh\/api"/);
});

test("agentic os paths and relative chunks stay untouched", () => {
  const rewritten = rewriteDshHtml('<a href="/login">x</a><script>const p = "assets/chunk.js";</script>');
  assert.match(rewritten, /href="\/login"/);
  assert.match(rewritten, /"assets\/chunk\.js"/);
  assert.equal(rewritten.includes("/dsh/login"), false);
});

test("a chunked upstream response is re-framed, not double-framed", async () => {
  // dsh streams its HTML chunked. The proxy rewrites the body and sets a
  // content-length; if the upstream's transfer-encoding header survived next
  // to it, the openresty in front of production answered with a bare 502.
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.write('<script src="/assets/a.js"></script>');
    res.end("<p>ok</p>");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const app = express();
  const server = http.createServer(app);
  // The auth wrapper is not under test here — the framing lives in the proxy
  // itself, so mount it the way mountDshProxy does, minus requireRoles.
  const proxy = createDshProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  app.use("/dsh", (req, res) => {
    req.url = stripDshPrefix(req.originalUrl || req.url);
    proxy.web(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const raw = await new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: server.address().port, path: "/dsh/" }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ headers: response.headers, status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
    });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["transfer-encoding"], undefined, "framing belongs to this hop, not the upstream");
    assert.equal(Number(raw.headers["content-length"]) > 0, true);
    assert.match(raw.body, /\/dsh\/assets\/a\.js/);
  } finally {
    server.close();
    upstream.close();
  }
});

test("an unreachable dsh reports itself instead of throwing", async () => {
  const status = await dshStatus(async () => { throw new Error("connect ECONNREFUSED"); });
  assert.equal(status.ready, false);
  assert.equal(status.url, "/dsh/");
  assert.match(status.error, /ECONNREFUSED/);
});

test("a live dsh probe is ready and points at the mount", async () => {
  const status = await dshStatus(async () => ({ status: 200 }));
  assert.deepEqual([status.ready, status.status, status.url], [true, 200, "/dsh/"]);
});
