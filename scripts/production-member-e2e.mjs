#!/usr/bin/env node
import crypto from "node:crypto";
import process from "node:process";

const base = String(process.env.AGENTIC_OS_PUBLIC_URL || "https://agent.milanapremium.uz").replace(/\/$/, "");
const runId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const password = `Mila-${crypto.randomBytes(12).toString("base64url")}!9`;
const accounts = [
  { name: "Release Member A", email: `release-a-${runId}@example.invalid`, token: "" },
  { name: "Release Member B", email: `release-b-${runId}@example.invalid`, token: "" },
];

async function request(path, { method = "GET", token = "", body, expected = [200] } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned HTTP ${response.status}: ${payload.error || text}`);
  }
  return { response, payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function remove(account) {
  if (!account.token) return;
  await request("/api/auth/account", {
    method: "DELETE",
    token: account.token,
    body: { confirmEmail: account.email, password },
    expected: [200, 401],
  }).catch(() => {});
}

try {
  for (const account of accounts) {
    const { payload } = await request("/api/auth/mobile/register", {
      method: "POST",
      body: { name: account.name, email: account.email, password },
      expected: [201],
    });
    assert(payload.accessToken, `mobile registration did not return a token for ${account.name}`);
    assert(payload.user?.role === "Member", `${account.name} did not receive the Member role`);
    account.token = payload.accessToken;
  }

  const owner = accounts[0];
  const outsider = accounts[1];
  const me = (await request("/api/auth/me", { token: owner.token })).payload;
  assert(me.authed === true && me.user?.email === owner.email, "mobile bearer token did not resolve the registered account");

  const webLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: owner.email, password },
  });
  assert(webLogin.payload.user?.id === me.user.id, "web and mobile login resolved different account identities");
  assert(webLogin.response.headers.get("set-cookie")?.includes("aos_session="), "web login did not establish a session cookie");

  const created = (await request("/api/member/tasks", {
    method: "POST",
    token: owner.token,
    body: { title: `Release isolation task ${runId}` },
    expected: [201],
  })).payload;
  assert(created.id, "member task was not created");

  const ownerTasks = (await request("/api/member/tasks", { token: owner.token })).payload;
  const outsiderTasks = (await request("/api/member/tasks", { token: outsider.token })).payload;
  assert(ownerTasks.some((task) => task.id === created.id), "owner cannot read the created task");
  assert(!outsiderTasks.some((task) => task.id === created.id), "another member can read the owner's task");

  await request(`/api/member/tasks/${encodeURIComponent(created.id)}`, {
    method: "PATCH",
    token: outsider.token,
    body: { title: "Cross-account mutation" },
    expected: [404],
  });

  const exported = (await request("/api/auth/account/export", { token: owner.token })).payload;
  assert(exported.format === "agentic-os-personal-export", "personal export format is missing");
  assert(exported.account?.id === me.user.id, "personal export belongs to another account");
  assert(typeof exported.soul?.content === "string" && exported.soul.content.length > 0, "per-user SOUL.md was not generated");

  await remove(owner);
  owner.token = "";
  await remove(outsider);
  outsider.token = "";

  await request("/api/auth/mobile/login", {
    method: "POST",
    body: { email: owner.email, password },
    expected: [401],
  });

  console.log("Production member journey passed: unified web/mobile identity, workspace isolation, SOUL export, and account cleanup.");
} finally {
  await Promise.all(accounts.map(remove));
}
