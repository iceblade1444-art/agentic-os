import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  hermesCronRequest, hermesKanbanRawRequest, hermesKanbanRequest, hermesSkillsRequest, resetHermesKanbanToken, withKanbanBoard,
} from "../server/lib/hermes-kanban.js";

test("Hermes Kanban connector pins requests to the Agentic OS board", () => {
  assert.equal(
    withKanbanBoard("/api/plugins/kanban/board?include_archived=false", "agentic-os"),
    "/api/plugins/kanban/board?include_archived=false&board=agentic-os",
  );
});

test("Hermes Kanban connector keeps the dashboard token server-side", async () => {
  resetHermesKanbanToken();
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/") return { status: 200, text: '<script>window.__HERMES_SESSION_TOKEN__="private-token";</script>' };
    return { status: 200, text: JSON.stringify({ columns: [] }) };
  };
  const result = await hermesKanbanRequest("/api/plugins/kanban/board?board=agentic-os", {}, request);
  assert.deepEqual(result, { columns: [] });
  assert.equal(calls[1].options.headers.Authorization, "Bearer private-token");
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test("Hermes Kanban connector preserves authenticated binary responses", async () => {
  resetHermesKanbanToken();
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/") return { status: 200, text: '<script>window.__HERMES_SESSION_TOKEN__="private-token";</script>' };
    return { status: 200, text: "binary-data", body: Buffer.from("binary-data"), headers: { "content-type": "text/plain" } };
  };
  const result = await hermesKanbanRawRequest("/api/plugins/kanban/attachments/7?board=agentic-os", {}, request);
  assert.equal(result.body.toString(), "binary-data");
  assert.equal(result.headers["content-type"], "text/plain");
  assert.equal(calls[1].options.headers.Authorization, "Bearer private-token");
});

test("Hermes Skills connector reuses private dashboard authentication", async () => {
  resetHermesKanbanToken();
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/") return { status: 200, text: '<script>window.__HERMES_SESSION_TOKEN__="skills-token";</script>' };
    return { status: 200, text: JSON.stringify([{ name: "deploy", enabled: true }]) };
  };
  const result = await hermesSkillsRequest("/api/skills?profile=dev", {}, request);
  assert.deepEqual(result, [{ name: "deploy", enabled: true }]);
  assert.equal(calls[1].options.headers.Authorization, "Bearer skills-token");
  await assert.rejects(() => hermesSkillsRequest("/api/config", {}, request), /Invalid Hermes Skills path/);
});

test("Hermes Cron connector keeps scheduler mutations behind the dashboard bridge", async () => {
  resetHermesKanbanToken();
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/") return { status: 200, text: '<script>window.__HERMES_SESSION_TOKEN__="cron-token";</script>' };
    return { status: 200, text: JSON.stringify([{ id: "daily-brief", schedule: "0 9 * * *" }]) };
  };
  const result = await hermesCronRequest("/api/cron/jobs?profile=all", {}, request);
  assert.equal(result[0].id, "daily-brief");
  assert.equal(calls[1].options.headers.Authorization, "Bearer cron-token");
  await assert.rejects(() => hermesCronRequest("/api/sessions", {}, request), /Invalid Hermes Cron path/);
});

test("Agentic OS exposes a real Hermes fleet Kanban instead of the local workflow canvas", () => {
  const page = fs.readFileSync(new URL("../assets/js/pages/workflows.js", import.meta.url), "utf8");
  const agents = fs.readFileSync(new URL("../assets/js/pages/agents.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../server/routes/kanban.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  for (const id of ["kanbanBoard", "kanbanFleet", "kanbanNew", "kanbanMode", "kanbanRefresh"]) {
    assert.match(page, new RegExp(`id=\\"${id}\\"`));
  }
  assert.match(page, /api\.kanban\.createTask/);
  assert.match(page, /api\.kanban\.updateTask/);
  assert.match(page, /taskRuns/);
  assert.match(page, /kanbanDetailPanel/);
  assert.match(page, /uploadAttachment/);
  assert.match(page, /downloadAttachment/);
  assert.match(page, /ondragstart/);
  assert.match(page, /block_kind === "needs_input"/);
  assert.match(page, /kanban\.agent\.waiting/);
  assert.match(agents, /api\.kanban\.profiles/);
  assert.match(agents, /api\.kanban\.probeProfiles/);
  assert.match(agents, /Check models/);
  assert.match(agents, /Waiting input/);
  assert.match(api, /\/api\/kanban\/board/);
  assert.match(api, /\/api\/kanban\/profiles\/probe/);
  assert.match(api, /taskLog/);
  assert.match(api, /deleteAttachment/);
  assert.match(routes, /MAX_ATTACHMENT_BYTES/);
  assert.match(routes, /multipart\/form-data/);
  assert.match(routes, /\/tasks\/:id\/log/);
  assert.match(routes, /mergeHermesFleetHealth/);
  assert.match(app, /route: "kanban"/);
  assert.doesNotMatch(page, /wf-canvas/);
});

test("Skill Studio manages the real Hermes catalog instead of browser mock data", () => {
  const page = fs.readFileSync(new URL("../assets/js/pages/misc.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../server/routes/skills.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  assert.match(page, /Skill Studio/);
  assert.match(page, /api\.skills\.list/);
  assert.match(page, /api\.skills\.toggle/);
  assert.match(page, /api\.skills\.hubInstall/);
  assert.doesNotMatch(page, /Web Search.*Code Interpreter.*SQL Query/s);
  assert.match(api, /\/api\/skills\/hub\/search/);
  assert.match(routes, /hermesSkillsRequest/);
  assert.match(routes, /requireAdmin/);
  assert.match(app, /label: "Skill Studio"/);
});

test("Routines UI manages native Hermes Cron jobs and exposes run history", () => {
  const page = fs.readFileSync(new URL("../assets/js/pages/routines.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../server/routes/routines.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  assert.match(page, /api\.routines\.create/);
  assert.match(page, /api\.routines\.action/);
  assert.match(page, /api\.routines\.runs/);
  assert.match(page, /Daily operations brief/);
  assert.match(api, /\/api\/routines\/delivery-targets/);
  assert.match(routes, /ACTIONS = new Set\(\["pause", "resume", "trigger"\]\)/);
  assert.match(routes, /requireAdmin/);
  assert.match(app, /route: "routines"/);
});
