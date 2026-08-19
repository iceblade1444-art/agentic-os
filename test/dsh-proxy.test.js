// The /dsh mount: DeepSeek Harness's root-assuming UI stays under the
// operator-authenticated prefix, and its loopback-only trust fence keeps
// being satisfied by the proxy, not bypassed by it.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dshStatus,
  isBareDshRequest,
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
