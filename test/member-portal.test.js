import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemberWorkspaceStore } from "../server/lib/member-workspace.js";
import { PERSONAL_ACTIONS, READ_ONLY_ERP_ACTIONS } from "../server/lib/mila-actions.js";
import { channelAllows } from "../server/lib/mila-audience.js";

const MEMBER_USER = { id: "usr_member", name: "Сотрудник", role: "Member" };

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-members-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemberWorkspaceStore(dir);
}

test("member tasks and notes are isolated by authenticated user id", (t) => {
  const store = temporaryStore(t);
  const alphaTask = store.createTask("usr_alpha", {
    title: "Alpha task",
    detail: "Private to alpha",
    priority: "high",
    dueDate: "2026-08-01",
  });
  const alphaNote = store.createNote("usr_alpha", { title: "Alpha note", content: "Private note" });
  store.createTask("usr_beta", { title: "Beta task" });
  store.createNote("usr_beta", { title: "Beta note" });

  assert.deepEqual(store.listTasks("usr_alpha").map((task) => task.title), ["Alpha task"]);
  assert.deepEqual(store.listNotes("usr_alpha").map((note) => note.title), ["Alpha note"]);
  assert.equal(store.updateTask("usr_beta", alphaTask.id, { title: "Stolen task" }), null);
  assert.equal(store.updateNote("usr_beta", alphaNote.id, { title: "Stolen note" }), null);
  assert.equal(store.deleteTask("usr_beta", alphaTask.id), false);
  assert.equal(store.deleteNote("usr_beta", alphaNote.id), false);
});

test("member workspace validates and bounds user input", (t) => {
  const store = temporaryStore(t);
  assert.throws(() => store.createTask("usr_member", { title: "x" }), /at least 2 characters/);
  assert.throws(() => store.createNote("usr_member", { title: "" }), /at least 2 characters/);
  const task = store.createTask("usr_member", {
    title: "A valid task",
    detail: "x".repeat(5000),
    priority: "unsupported",
    status: "unsupported",
    dueDate: "not-a-date",
  });
  assert.equal(task.detail.length, 4000);
  assert.equal(task.priority, "normal");
  assert.equal(task.status, "todo");
  assert.equal(task.dueDate, "");
});

test("member dashboard reports only the current personal workspace", (t) => {
  const store = temporaryStore(t);
  store.createTask("usr_member", { title: "Open", status: "todo", dueDate: "2020-01-01" });
  store.createTask("usr_member", { title: "Doing", status: "doing" });
  store.createTask("usr_member", { title: "Done", status: "done" });
  store.createNote("usr_member", { title: "One note" });
  store.createTask("usr_other", { title: "Other user's task" });

  const dashboard = store.dashboard("usr_member");
  assert.deepEqual(dashboard.counts, { open: 2, doing: 1, due: 1, notes: 1, unread: 0 });
  assert.equal(dashboard.tasks.some((task) => task.title.includes("Other")), false);
});

test("member chat and inbox sync are idempotent and isolated", (t) => {
  const store = temporaryStore(t);
  const message = {
    id: "mobile:one",
    role: "user",
    text: "Hello MILA",
    source: "mobile",
    createdAt: "2026-07-31T10:00:00.000Z",
    updatedAt: "2026-07-31T10:00:00.000Z",
  };
  store.syncChat("usr_alpha", { messages: [message, message] });
  assert.equal(store.listChat("usr_alpha").length, 1);
  assert.equal(store.listChat("usr_beta").length, 0);

  const item = store.createInboxItem("usr_alpha", {
    id: "notice:one",
    type: "reminder",
    title: "Review task",
    body: "The agent is waiting.",
  });
  assert.equal(store.unreadInboxCount("usr_alpha"), 1);
  assert.equal(store.unreadInboxCount("usr_beta"), 0);
  assert.equal(store.updateInboxItem("usr_beta", item.id, { status: "read" }), null);
  assert.equal(store.updateInboxItem("usr_alpha", item.id, { status: "read" }).status, "read");
  assert.equal(store.unreadInboxCount("usr_alpha"), 0);
});

test("frontend and server expose distinct member and operator surfaces", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const proxy = fs.readFileSync(new URL("../server/lib/hermes-proxy.js", import.meta.url), "utf8");

  assert.match(app, /const MEMBER_SECTIONS/);
  assert.match(app, /const MEMBER_PAGES/);
  // The dock follows the Mila Live page, not the operator flag — Member has both.
  assert.match(app, /if \(pages\(\)\.mila\) mountMilaDock\(\)/);
  assert.match(api, /\/api\/member\/tasks/);
  assert.match(server, /app\.use\("\/api\/member", member\)/);
  assert.match(server, /\/api\/auth\/mobile\/login/);
  assert.match(server, /\/api\/auth\/mobile\/register/);
  // integrations and mila are intentionally NOT in this list — Mila voice/chat
  // inside them is open to every signed-in role; see the Mila Live test below.
  for (const route of ["mcp", "kanban", "claude-code", "operations", "skills"]) {
    assert.equal(server.includes(`app.use("/api/${route}", requireOperator`), true);
  }
  assert.match(proxy, /requireRoles\("Creator", "Admin", "CEO"\)/);
  assert.match(proxy, /hasHermesAccess/);
});

test("Design gets the studio surface without operator controls", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const studioRoutes = fs.readFileSync(new URL("../server/routes/studio.js", import.meta.url), "utf8");

  assert.match(app, /const DESIGN_SECTIONS/);
  assert.match(app, /const DESIGN_PAGES/);
  assert.match(app, /api\.auth\.canStudio \? DESIGN_SECTIONS : MEMBER_SECTIONS/);
  // Design must not reach the operator-only surfaces through the router.
  const designNav = app.slice(app.indexOf("const DESIGN_SECTIONS"), app.indexOf("const OPERATOR_PAGES"));
  for (const route of ["hermes", "kanban", "secrets", "integrations", "mcp", "analytics", "agents"]) {
    assert.equal(designNav.includes(`route: "${route}"`), false, `DESIGN_SECTIONS must not expose ${route}`);
  }

  assert.match(server, /const requireStudio = requireRoles\("Creator", "Admin", "CEO", "Design"\)/);
  assert.match(server, /app\.use\("\/api\/studio", requireStudio, studio\)/);
  assert.match(server, /app\.use\("\/api\/knowledge", requireStudio, knowledge\)/);
  for (const route of ["mcp", "kanban", "operations"]) {
    assert.equal(server.includes(`app.use("/api/${route}", requireOperator`), true);
  }
  // Analytics signals and the Higgsfield account connection stay with operators.
  assert.match(studioRoutes, /OPERATOR_BUCKETS = new Set\(\["signals"\]\)/);
  assert.match(studioRoutes, /r\.post\("\/higgsfield\/connect", requireOperator/);
});

test("registration waits for owner approval end to end", () => {
  const auth = fs.readFileSync(new URL("../server/lib/auth.js", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../server/config.js", import.meta.url), "utf8");
  const readAdapter = fs.readFileSync(new URL("../server/lib/postgres-auth-read.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../assets/js/api.js", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../assets/js/pages/settings.js", import.meta.url), "utf8");

  // On by default; REQUIRE_ACCOUNT_APPROVAL=false is the only way out.
  assert.match(config, /requireAccountApproval: env\.REQUIRE_ACCOUNT_APPROVAL !== "false"/);
  assert.match(auth, /code: "approval_pending"/);
  // Both sign-in paths and both registration paths go through the gate.
  assert.equal(auth.split("approvalPending(user, res)").length - 1, 3);
  assert.equal(auth.split("requiresApproval: config.requireAccountApproval").length - 1, 2);
  assert.equal(auth.split("approvalRequired: true").length - 1, 2);
  // The Postgres read path rejects pending sessions exactly like the JSON store.
  assert.match(readAdapter, /if \(!user \|\| user\.disabled \|\| user\.approvedAt === ""\) return null/);
  assert.match(api, /if \(result\.verificationRequired \|\| result\.approvalRequired\) return result/);
  assert.match(settings, /api\.auth\.updateUser\(button\.dataset\.userId, \{ approved: approve \}\)/);
});

test("ERP is readable by every role but its write tools stay with operators", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const erpRoutes = fs.readFileSync(new URL("../server/routes/erp.js", import.meta.url), "utf8");
  const erpPage = fs.readFileSync(new URL("../assets/js/pages/erp.js", import.meta.url), "utf8");

  // Mounted without requireOperator — every signed-in role reaches the snapshot.
  assert.match(server, /app\.use\("\/api\/erp", erp\)/);
  const memberNav = app.slice(app.indexOf("const MEMBER_SECTIONS"), app.indexOf("const DESIGN_SECTIONS"));
  // ERP is Member's landing page: route "" renders it instead of a separate nav entry.
  assert.match(memberNav, /route: "", navKey: "erp"/);
  assert.match(app, /const MEMBER_PAGES = \{[^}]*erp[^}]*\}/);
  // Design is unaffected: it keeps its own dashboard at "" plus a distinct ERP entry.
  const designNav = app.slice(app.indexOf("const DESIGN_SECTIONS"), app.indexOf("const OPERATOR_PAGES"));
  assert.match(designNav, /route: "erp"/);
  assert.match(app, /const DESIGN_PAGES = \{ \.\.\.MEMBER_PAGES, "": memberHome/);

  // erp_create_task and erp_send_notification are not read-only, so they 403.
  assert.match(erpRoutes, /READ_ONLY_TOOLS = new Set\(\[\.\.\.READ_TOOLS\.map\(\(\[tool\]\) => tool\), "erp_search"\]\)/);
  assert.match(erpRoutes, /!READ_ONLY_TOOLS\.has\(String\(tool\)\) && !isOperator\(req\)/);
  assert.match(erpRoutes, /r\.post\("\/wiki-sync", requireOperator/);
  assert.match(erpPage, /api\.auth\.canAdmin \? `<button class="btn btn-secondary" id="erpWikiSync"/);
});

test("Member gets Mila Live for conversation only, not the operator tool actions", () => {
  const app = fs.readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const integrations = fs.readFileSync(new URL("../server/routes/integrations.js", import.meta.url), "utf8");
  const milaActionsRoute = fs.readFileSync(new URL("../server/routes/mila-actions.js", import.meta.url), "utf8");
  const milaTools = fs.readFileSync(new URL("../assets/js/mila-tools.js", import.meta.url), "utf8");
  const milaSession = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");

  // Member has Mila Live and Design explicitly does not inherit it. She is no
  // longer a rail section — an assistant is not a destination — so the gate is
  // the page map, and the orb in the rail renders only where that map has her.
  assert.match(app, /const MEMBER_PAGES = \{[^}]*mila[^}]*\}/);
  assert.match(app, /\$\{pages\(\)\.mila \? `<a class="rail-orb tip"/);
  assert.match(app, /const DESIGN_PAGES = \{ \.\.\.MEMBER_PAGES, "": memberHome, mila: undefined/);

  // Neither /api/integrations nor /api/mila carry the blanket operator gate anymore —
  // authorization for the risky parts moved inside each router.
  assert.match(server, /app\.use\("\/api\/integrations", integrations\)/);
  assert.match(server, /app\.use\("\/api\/mila", milaActions\)/);

  // Status, token minting and chat have no per-route admin gate — every signed-in
  // role reaches them. Devices, pairing, subscription and app-update still require it.
  assert.match(integrations, /r\.get\("\/", requireAdmin,/);
  assert.match(integrations, /r\.get\("\/mila\/status", milaAction/);
  assert.match(integrations, /r\.post\("\/mila\/voice-token", milaAction/);
  assert.match(integrations, /r\.post\("\/mila\/livekit-token", milaAction/);
  assert.match(integrations, /r\.post\("\/mila\/chat", milaAction/);
  for (const route of ["/mila/devices\", requireAdmin", "/mila/connection-code\", requireAdmin", "/mila/subscription\", requireAdmin", "/mila/app-update\", requireAdmin"]) {
    assert.equal(integrations.includes(route), true, `expected admin gate on ${route}`);
  }

  // The tool-calling endpoint enforces its own allowlist: the two read-only ERP
  // actions and the caller's own personal desk pass for a non-operator, everything
  // else (Kanban, Hermes, Obsidian, Claude Code, MCP) 403s regardless of what the
  // client declared.
  // The list itself lives in mila-actions.js and is imported here: four
  // surfaces need the same answer, and the copies drifted. What matters to this
  // test is the contents of the gate, not where the words are typed.
  assert.match(milaActionsRoute, /import \{[^}]*READ_ONLY_ERP_ACTIONS[^}]*\} from "\.\.\/lib\/mila-actions\.js"/);
  assert.deepEqual(
    [...READ_ONLY_ERP_ACTIONS].sort(),
    ["get_erp_business_context", "get_finished_goods_stock", "get_sewing_daily_report"],
  );
  // Company knowledge joins the everyone list: it is read-only and scoped to one
  // vault folder, so an employee looking up a price reaches nothing that was not
  // meant for them.
  // The route asks mila-audience.js rather than judging for itself, and the
  // channel comes from the credential — a voice agent cannot request a wider
  // door than the one its token was minted for.
  assert.match(milaActionsRoute, /channelAllows\(name, authenticatedUser\(req\), requestChannel\(req\)\)/);
  assert.match(milaActionsRoute, /if \(!permitted\(req, name\)\)/);
  // And behaviourally: a Member reaches their own desk and the ERP reads, and
  // nothing that belongs to an operator.
  for (const name of [...PERSONAL_ACTIONS, ...READ_ONLY_ERP_ACTIONS]) {
    assert.ok(channelAllows(name, MEMBER_USER, "app"), `${name} must stay open to a Member`);
  }
  for (const name of ["create_kanban_task", "ask_claude_code", "call_mcp_tool", "get_attendance_today"]) {
    assert.equal(channelAllows(name, MEMBER_USER, "app"), false, `${name} must stay operator-only`);
  }
  for (const operatorOnly of ["create_kanban_task", "delegate_to_hermes", "write_obsidian_note", "ask_claude_code", "call_mcp_tool"]) {
    assert.equal(PERSONAL_ACTIONS.has(operatorOnly), false, `${operatorOnly} must stay operator-only`);
  }
  // Personal actions run against req.user, so a Member reaches their own desk and
  // nobody else's — the route has to hand the user object down, not just a name.
  assert.match(milaActionsRoute, /milaActions\.call\(name, req\.body\?\.args \|\| \{\}, \{ actor: user\?\.name \|\| "Creator", user \}\)/);

  // The client mirrors the same allowlist so Mila never offers an action it cannot run.
  assert.match(milaTools, /MILA_MEMBER_TOOLS = MILA_TOOLS\.filter/);
  // One place decides the session's tools, and both the live socket and the
  // prompt read it, so the two can never describe different capabilities.
  assert.match(milaSession, /get declaredTools\(\) \{\s*return api\.auth\.canAdmin \? MILA_TOOLS : MILA_MEMBER_TOOLS;/);
  assert.match(milaSession, /tools: this\.declaredTools,/);
  assert.match(milaSession, /tools: this\.declaredTools\.map\(\(tool\) => tool\.name\)/);

  // Member keeps the floating dock, so leaving #/mila cannot strand a live call
  // with no way to end it.
  assert.match(app, /if \(pages\(\)\.mila\) mountMilaDock\(\)/);
  assert.match(app, /const pages = \(\) =>/);
});

test("a second mic click joins the in-flight call instead of opening another socket", () => {
  const session = fs.readFileSync(new URL("../assets/js/mila-session.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../assets/js/pages/mila.js", import.meta.url), "utf8");

  // start() awaits loadStatus() and the ERP snapshot before it can assign
  // this.session; the shared promise is what closes that window.
  assert.match(session, /this\.startPromise = null;/);
  assert.match(session, /if \(!this\.startPromise\) \{/);
  assert.match(session, /this\.startPromise = this\.#start\(\)\.finally/);
  assert.match(session, /return this\.startPromise;/);
  // stop() must not race a connect that has not claimed this.session yet.
  const stopBody = /async stop\(\) \{[\s\S]*?\n  \}/.exec(session)[0];
  assert.match(stopBody, /if \(this\.startPromise\) await this\.startPromise\.catch/);
  // The button reports the attempt rather than looking inert.
  assert.match(session, /starting: !!this\.startPromise/);
  assert.match(page, /mic\.disabled = state\.starting/);
});
