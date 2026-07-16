import { store, timeAgo } from "../store.js";
import { icon } from "../icons.js";
import { esc, toast, statusBadge, lineChart, donut, bars, ring, randomSeries, agentIcon, confirmDialog, openModal, closeOverlay } from "../ui.js";
import { api } from "../api.js";

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

function head(title, sub, actionHTML = "") {
  return `<div class="page-head"><div><div class="page-title">${title}</div><div class="page-sub">${sub}</div></div><div class="spacer"></div>${actionHTML}</div>`;
}
// lazily initialise auxiliary collections so seed stays lean
function ensure(key, factory) {
  if (!store.state[key]) store.set((s) => (s[key] = factory()));
  return store.state[key];
}

/* ============================ TOOLS ============================ */
export const tools = {
  title: "Tools",
  render() {
    const list = ensure("tools_", () => [
      { id: "t1", name: "Web Search", cat: "Data", desc: "Search the web for fresh info", icon: "search", color: "violet", on: true },
      { id: "t2", name: "Code Interpreter", cat: "Compute", desc: "Run Python in a sandbox", icon: "terminal", color: "blue", on: true },
      { id: "t3", name: "SQL Query", cat: "Data", desc: "Query connected databases", icon: "database", color: "green", on: true },
      { id: "t4", name: "Send Email", cat: "Action", desc: "Send email via SMTP/API", icon: "mail", color: "pink", on: false },
      { id: "t5", name: "HTTP Request", cat: "Action", desc: "Call any REST endpoint", icon: "cloud", color: "cyan", on: true },
      { id: "t6", name: "File Reader", cat: "Data", desc: "Read PDFs, docs, sheets", icon: "file", color: "amber", on: true },
      { id: "t7", name: "Image Gen", cat: "Media", desc: "Generate images from prompts", icon: "sparkles", color: "violet", on: false },
      { id: "t8", name: "Calendar", cat: "Action", desc: "Create & read events", icon: "calendar", color: "blue", on: false },
    ]);
    return head("Tools", `${list.filter((t) => t.on).length} of ${list.length} enabled`, `<button class="btn btn-primary">${icon("plus")}Add tool</button>`) + `
      <div class="grid cols-3">
        ${list.map((t) => `
          <div class="card tile">
            <div class="row between">
              <div class="aico" style="background:${store.colors[t.color]}">${icon(t.icon)}</div>
              <label class="switch"><input type="checkbox" data-tool="${t.id}" ${t.on ? "checked" : ""}/><span class="track"></span><span class="thumb"></span></label>
            </div>
            <div class="fw-700 mt-4">${t.name}</div>
            <div class="hint">${t.desc}</div>
            <span class="badge neutral mt-2">${t.cat}</span>
          </div>`).join("")}
      </div>`;
  },
  mount(root) {
    root.querySelectorAll("[data-tool]").forEach((c) => (c.onchange = () => {
      store.set((s) => (s.tools_.find((t) => t.id === c.dataset.tool).on = c.checked));
      toast(c.checked ? "success" : "info", "Tool " + (c.checked ? "enabled" : "disabled"));
    }));
  },
};

/* ============================ KNOWLEDGE ============================ */
export const knowledge = {
  title: "Knowledge",
  render() {
    const actions = `<button class="btn btn-secondary" id="knowledgeRefresh">${icon("refresh")}Refresh</button><button class="btn btn-primary" id="knowledgeNew">${icon("plus")}New note</button>`;
    return head("Obsidian Library", "Shared Markdown knowledge used by Hermes and Agentic OS agents", actions)
      + `<div id="knowledgeBody">${loadingCard("Reading Obsidian vault…")}</div>`;
  },
  mount(root) {
    if (!api.on) {
      root.querySelector("#knowledgeBody").innerHTML = demoNote("Start the Node backend to read the real Obsidian vault.");
      return;
    }
    knowledgeMount(root);
  },
};

function knowledgeBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function knowledgeAction(entry) {
  const labels = { list: "listed notes", read: "read", search: "searched", create: "created", append: "updated" };
  return labels[entry.action] || entry.action;
}

function knowledgeMount(root) {
  const body = root.querySelector("#knowledgeBody");
  let status = null;
  let notes = [];
  let usage = [];
  let selected = null;
  let query = "";
  let searchTimer = null;

  const draw = () => {
    if (!status) return;
    const activePath = selected?.path || "";
    body.innerHTML = `
      <div class="grid cols-4 knowledge-stats">
        ${statMini("Notes", status.notes, "file")}
        ${statMini("Folders", status.folders, "knowledge")}
        ${statMini("Vault size", knowledgeBytes(status.bytes), "database")}
        ${statMini("Agent access", status.mcp.status === "active" ? "Active" : "Offline", "network")}
      </div>
      <div class="knowledge-status">
        <span class="knowledge-logo">${icon("book")}</span>
        <div><strong>${esc(status.name)}</strong><span class="mono">${esc(status.path)}</span></div>
        <span class="badge ${status.ready && status.writable ? "success" : "warning"}"><span class="dot"></span>${status.writable ? "Read + write" : "Read only"}</span>
        <span class="badge ${status.mcp.status === "active" ? "success" : "error"}"><span class="dot"></span>MCP ${esc(status.mcp.status)}</span>
        <span class="knowledge-updated">${status.updatedAt ? `Updated ${timeAgo(status.updatedAt)}` : "Empty vault"}</span>
      </div>
      <div class="knowledge-workspace">
        <section class="knowledge-browser" aria-label="Obsidian notes">
          <div class="knowledge-toolbar">
            <div class="search knowledge-search">${icon("search")}<input id="knowledgeSearch" value="${esc(query)}" placeholder="Search notes, tags and folders…"/></div>
            <span>${notes.length} notes</span>
          </div>
          <div class="knowledge-note-list" id="knowledgeNoteList">
            ${notes.length ? notes.map((note) => `<button class="knowledge-note ${note.path === activePath ? "active" : ""}" type="button" data-note-path="${esc(note.path)}">
              <span class="knowledge-note-icon">${icon("file")}</span>
              <span class="knowledge-note-copy"><strong>${esc(note.title)}</strong><small>${esc(note.path)}</small><em>${esc(note.excerpt || "Empty note")}</em></span>
              <span class="knowledge-note-meta"><time>${timeAgo(note.updatedAt)}</time><small>${knowledgeBytes(note.size)}</small></span>
            </button>`).join("") : `<div class="empty knowledge-empty"><div class="empty-ico">${icon("search")}</div><h4>No notes found</h4><p>Try another search or create a note.</p></div>`}
          </div>
        </section>
        <section class="knowledge-inspector" aria-label="Selected Obsidian note">
          <div class="knowledge-preview" id="knowledgePreview">
            ${selected ? `<div class="knowledge-preview-head"><div><strong>${esc(selected.title)}</strong><span>${esc(selected.path)}</span></div><span class="badge neutral">${knowledgeBytes(selected.size)}</span></div>
              <div class="knowledge-note-facts">
                <span>${icon("layers")}${esc(selected.folder)}</span>
                <span>${icon("network")}${selected.links.length} links</span>
                <span>${icon("clock")}${timeAgo(selected.updatedAt)}</span>
              </div>
              ${selected.tags.length ? `<div class="knowledge-tags">${selected.tags.map((tag) => `<span>#${esc(tag)}</span>`).join("")}</div>` : ""}
              <pre class="knowledge-markdown">${esc(selected.content)}</pre>`
              : `<div class="empty knowledge-empty"><div class="empty-ico">${icon("book")}</div><h4>Select a note</h4><p>Its Markdown content, links and tags will appear here.</p></div>`}
          </div>
          <div class="knowledge-agents">
            <div class="knowledge-section-head"><div><strong>How agents use this library</strong><span>${esc(status.access.orchestrator)} through the Agentic OS MCP bridge</span></div><span class="badge ${status.mcp.status === "active" ? "success" : "error"}">${status.access.tools.length} tools</span></div>
            <div class="knowledge-tool-list">${status.access.tools.map((tool) => `<span class="mono">${esc(tool)}</span>`).join("")}</div>
            <div class="knowledge-usage" id="knowledgeUsage">
              ${usage.length ? usage.slice(0, 8).map((entry) => `<div class="knowledge-use-row"><span class="knowledge-use-icon">${icon(entry.action === "search" ? "search" : entry.action === "read" ? "eye" : entry.action === "list" ? "layers" : "edit")}</span><div><strong>${esc(entry.actor)}</strong><span>${esc(knowledgeAction(entry))}${entry.path ? ` · ${esc(entry.path)}` : entry.query ? ` · “${esc(entry.query)}”` : ""}</span></div><time>${timeAgo(entry.at)}</time></div>`).join("")
                : `<div class="knowledge-no-usage">No agent access recorded yet. Tool calls will appear here.</div>`}
            </div>
          </div>
        </section>
      </div>`;
    wire();
  };

  const selectNote = async (path) => {
    try {
      selected = await api.knowledge.read(path);
      usage = await api.knowledge.usage(50);
      draw();
      body.querySelector("#knowledgePreview")?.scrollTo(0, 0);
    } catch (error) { toast("error", "Obsidian", error.message); }
  };

  const load = async (nextQuery = query) => {
    query = nextQuery;
    try {
      [status, notes, usage] = await Promise.all([
        api.knowledge.status(), api.knowledge.list(query), api.knowledge.usage(50),
      ]);
      if (selected && !notes.some((note) => note.path === selected.path)) selected = null;
      draw();
      if (!selected && notes[0]) await selectNote(notes[0].path);
    } catch (error) {
      body.innerHTML = `<div class="alert error"><span class="a-ico">${icon("warn")}</span><div class="a-body"><div class="a-title">Obsidian library unavailable</div><div class="a-desc">${esc(error.message)}</div></div></div>`;
    }
  };

  const wire = () => {
    body.querySelectorAll("[data-note-path]").forEach((button) => {
      button.onclick = () => selectNote(button.dataset.notePath);
    });
    const search = body.querySelector("#knowledgeSearch");
    search.oninput = () => {
      clearTimeout(searchTimer);
      const value = search.value;
      searchTimer = setTimeout(() => load(value.trim()), 280);
    };
  };

  root.querySelector("#knowledgeRefresh").onclick = () => load();
  root.querySelector("#knowledgeNew").onclick = () => openModal({
    title: "New Obsidian note",
    width: 680,
    body: `<div class="field"><label class="label">Vault path</label><input class="input" id="knowledgeNewPath" placeholder="Projects/New idea.md"/></div><div class="field mt-3"><label class="label">Markdown</label><textarea class="textarea" id="knowledgeNewContent" rows="12" placeholder="# New idea\n\nWrite durable knowledge here…"></textarea></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="knowledgeCreate">${icon("save")}Create note</button>`,
    onMount: (modal) => {
      modal.querySelector("#knowledgeNewPath").focus();
      modal.querySelector("#knowledgeCreate").onclick = async () => {
        const path = modal.querySelector("#knowledgeNewPath").value.trim();
        const content = modal.querySelector("#knowledgeNewContent").value;
        if (!path) return toast("error", "Obsidian", "Add a vault path");
        try {
          selected = await api.knowledge.create({ path, content });
          closeOverlay();
          toast("success", "Obsidian", `Created ${selected.path}`);
          await load();
        } catch (error) { toast("error", "Obsidian", error.message); }
      };
    },
  });
  load();
}

/* ============================ MEMORY ============================ */
export const memory = {
  title: "Memory",
  render() {
    const mems = ensure("mems", () => [
      { id: "m1", key: "user.timezone", scope: "user", value: "America/Los_Angeles", updated: Date.now() - 12e5 },
      { id: "m2", key: "project.stack", scope: "project", value: "Vanilla JS + static hosting", updated: Date.now() - 36e5 },
      { id: "m3", key: "pref.tone", scope: "user", value: "concise, technical", updated: Date.now() - 72e5 },
      { id: "m4", key: "agent.research.last_topic", scope: "agent", value: "multi-agent orchestration", updated: Date.now() - 6e5 },
    ]);
    return head("Memory", "Long-term memory shared across agents & sessions") + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini("Entries", mems.length, "memory")}
        ${statMini("Vectors", "18.4K", "network")}
        ${statMini("Recall hits", "94%", "activity")}
        ${statMini("Store", "SQLite", "database")}
      </div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Key</th><th>Scope</th><th>Value</th><th>Updated</th></tr></thead>
        <tbody>${mems.map((m) => `<tr><td class="mono">${esc(m.key)}</td><td><span class="badge ${m.scope === "user" ? "info" : m.scope === "project" ? "primary" : "warning"}">${m.scope}</span></td><td class="muted">${esc(m.value)}</td><td class="muted nowrap">${timeAgo(m.updated)}</td></tr>`).join("")}</tbody>
      </table></div></div>`;
  },
};

/* ============================ MCP SERVERS ============================ */
export const mcp = {
  title: "MCP Servers",
  render() {
    const action = `<button class="btn btn-primary" id="addMcp">${icon("plus")}Add server</button>`;
    if (!api.on) {
      const list = store.state.mcpServers;
      return head("MCP Servers", "Model Context Protocol servers exposing tools over stdio", action)
        + demoNote("Start the Node backend (npm start) to spawn real MCP servers and call their tools.")
        + mcpTableHTML(list.map((m) => ({ id: m.id, name: m.name, desc: m.cmd, kind: "custom", status: m.status === "active" ? "active" : "stopped", tools: m.tools })));
    }
    return head("MCP Servers", "Spawn real MCP servers over stdio and call their tools", action)
      + `<div id="mcpBody">${loadingCard("Loading servers…")}</div>`;
  },
  mount(root) {
    if (!api.on) return mcpMountLocal(root);
    mcpMountReal(root);
  },
};

/* ============================ INTEGRATIONS ============================ */
export const integrations = {
  title: "Integrations",
  render() {
    if (!api.on) {
      const list = store.state.integrations;
      return head("Integrations", `${list.filter((i) => i.connected).length} connected`, "")
        + demoNote("Start the Node backend to make real connections (OpenAI, Anthropic, GitHub, Notion, Slack).")
        + `<div class="grid cols-3">${list.map(intCardLocal).join("")}</div>`;
    }
    return head("Integrations", "Connect services with real credential checks", "")
      + `<div id="intBody">${loadingCard("Loading integrations…")}</div>`;
  },
  mount(root) {
    if (!api.on) return intMountLocal(root);
    intMountReal(root);
  },
};

/* ============================ OBSERVABILITY ============================ */
export const observability = {
  title: "Observability",
  render() {
    const logs = [
      { lvl: "info", agent: "Research Agent", msg: "Tool call: search_web(query='ai agents')", at: Date.now() - 12e4 },
      { lvl: "info", agent: "Data Analyst", msg: "Executed SQL in 240ms · 1,250 rows", at: Date.now() - 3e5 },
      { lvl: "warn", agent: "Content Writer", msg: "Rate limit approaching (85% of quota)", at: Date.now() - 6e5 },
      { lvl: "error", agent: "Content Writer", msg: "Tool call failed: seo_check timed out", at: Date.now() - 9e5 },
      { lvl: "info", agent: "Support Agent", msg: "Resolved ticket #1234", at: Date.now() - 12e5 },
    ];
    return head("Observability", "Live traces, logs and performance metrics") + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini("Requests (24h)", "14,208", "activity")}
        ${statMini("Avg latency", "1.2s", "clock")}
        ${statMini("Error rate", "0.8%", "warn")}
        ${statMini("P95 latency", "3.4s", "up")}
      </div>
      <div class="grid" style="grid-template-columns:2fr 1fr;margin-bottom:16px">
        <div class="card pad-lg"><div class="card-head"><h3>Requests & latency</h3></div>${lineChart({ series: [{ name: "req", color: "var(--violet-500)", data: randomSeries(12, 60, 40) }, { name: "lat", color: "var(--cyan)", data: randomSeries(12, 40, 30) }], labels: ["", "", "", "", "", "", "", "", "", "", "", ""], w: 680, h: 220, showAxis: true })}</div>
        <div class="card pad-lg"><div class="card-head"><h3>Status mix</h3></div><div style="display:grid;place-items:center">${donut({ segments: [{ label: "2xx", value: 92, color: "var(--success)" }, { label: "4xx", value: 6, color: "var(--warning)" }, { label: "5xx", value: 2, color: "var(--error)" }], size: 170, thickness: 22, centerLabel: "99.2%", centerSub: "success" })}</div></div>
      </div>
      <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>Recent logs</h3></div><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Level</th><th>Agent</th><th>Message</th><th>Time</th></tr></thead>
        <tbody>${logs.map((l) => `<tr><td><span class="badge ${l.lvl === "error" ? "error" : l.lvl === "warn" ? "warning" : "info"}">${l.lvl}</span></td><td class="fw-600">${esc(l.agent)}</td><td class="mono text-sm muted">${esc(l.msg)}</td><td class="muted nowrap">${timeAgo(l.at)}</td></tr>`).join("")}</tbody>
      </table></div></div>`;
  },
};

/* ============================ GUARDRAILS ============================ */
export const guardrails = {
  title: "Guardrails",
  render() {
    const rules = ensure("guards", () => [
      { id: "g1", name: "PII redaction", desc: "Mask emails, phone numbers and SSNs in I/O", on: true },
      { id: "g2", name: "Toxicity filter", desc: "Block toxic or unsafe generations", on: true },
      { id: "g3", name: "Prompt-injection shield", desc: "Ignore instructions found in tool output", on: true },
      { id: "g4", name: "Rate limiting", desc: "Cap requests per agent per minute", on: false },
      { id: "g5", name: "Allowed tools only", desc: "Restrict agents to an approved tool list", on: true },
      { id: "g6", name: "Human approval", desc: "Require approval for irreversible actions", on: false },
    ]);
    return head("Guardrails", `${rules.filter((r) => r.on).length} of ${rules.length} active`) + `
      <div class="grid cols-2">
        ${rules.map((r) => `<div class="card"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors.green}">${icon("shield")}</div><div class="stack"><span class="fw-700">${r.name}</span><span class="hint">${r.desc}</span></div></div><label class="switch"><input type="checkbox" data-guard="${r.id}" ${r.on ? "checked" : ""}/><span class="track"></span><span class="thumb"></span></label></div></div>`).join("")}
      </div>`;
  },
  mount(root) {
    root.querySelectorAll("[data-guard]").forEach((c) => (c.onchange = () => {
      store.set((s) => (s.guards.find((r) => r.id === c.dataset.guard).on = c.checked));
      toast(c.checked ? "success" : "info", "Guardrail " + (c.checked ? "enabled" : "disabled"));
    }));
  },
};

/* ============================ SECRETS ============================ */
export const secrets = {
  title: "Secrets",
  render() {
    const list = ensure("secrets_", () => [
      { id: "s1", name: "OPENAI_API_KEY", updated: Date.now() - 8e6 },
      { id: "s2", name: "SLACK_WEBHOOK_URL", updated: Date.now() - 26e6 },
      { id: "s3", name: "POSTGRES_URL", updated: Date.now() - 5e6 },
    ]);
    return head("Secrets", "Encrypted credentials available to your agents", `<button class="btn btn-primary" id="addSecret">${icon("plus")}Add secret</button>`) + `
      <div class="alert info mb-4"><span class="a-ico">${icon("lock")}</span><div class="a-body"><div class="a-title">Values are write-only</div><div class="a-desc">For your safety this demo never displays secret values. In production, store them in an encrypted vault.</div></div></div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Value</th><th>Updated</th><th></th></tr></thead>
        <tbody>${list.map((s) => `<tr><td class="mono fw-600">${esc(s.name)}</td><td class="mono muted">•••••••••••••</td><td class="muted nowrap">${timeAgo(s.updated)}</td><td><button class="btn sm btn-ghost" data-del-secret="${s.id}" style="color:var(--error)">${icon("trash")}</button></td></tr>`).join("")}</tbody>
      </table></div></div>`;
  },
  mount(root) {
    root.querySelectorAll("[data-del-secret]").forEach((b) => (b.onclick = () => confirmDialog({ title: "Delete secret", message: "Remove this secret? Agents relying on it will fail.", confirmText: "Delete", onConfirm: () => { store.set((s) => (s.secrets_ = s.secrets_.filter((x) => x.id !== b.dataset.delSecret))); toast("success", "Secret deleted"); rerender(); } })));
    const add = root.querySelector("#addSecret");
    if (add) add.onclick = () => openModal({
      title: "Add secret", width: 460,
      body: `<div class="field"><label class="label">Name</label><input class="input mono" id="sn" placeholder="MY_API_KEY"/></div><div class="field"><label class="label">Value</label><input class="input mono" id="sv" type="password" placeholder="••••••••"/><span class="hint">Stored write-only in this demo.</span></div>`,
      footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sok">${icon("lock")}Save secret</button>`,
      onMount: (m) => (m.querySelector("#sok").onclick = () => { const n = m.querySelector("#sn").value.trim(); if (!n) return toast("error", "Name required"); store.set((s) => s.secrets_.push({ id: store.uid(), name: n, updated: Date.now() })); closeOverlay(); toast("success", "Secret saved", n); rerender(); }),
    });
  },
};

/* ============================ EVALUATIONS ============================ */
export const evaluations = {
  title: "Evaluations",
  render() {
    const runs = [
      { id: "e1", name: "Research quality", agent: "Research Agent", score: 96, pass: true, cases: 120, at: Date.now() - 3e6 },
      { id: "e2", name: "Answer faithfulness", agent: "Support Agent", score: 92, pass: true, cases: 200, at: Date.now() - 8e6 },
      { id: "e3", name: "Code correctness", agent: "Code Reviewer", score: 78, pass: false, cases: 64, at: Date.now() - 12e6 },
      { id: "e4", name: "Tone & style", agent: "Content Writer", score: 88, pass: true, cases: 90, at: Date.now() - 20e6 },
    ];
    return head("Evaluations", "Automated quality scoring for your agents", `<button class="btn btn-primary">${icon("play")}Run eval</button>`) + `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${statMini("Avg score", "88.5", "evaluations")}
        ${statMini("Pass rate", "75%", "check")}
        ${statMini("Eval cases", "474", "layers")}
        ${statMini("Regressions", "1", "down")}
      </div>
      <div class="grid" style="grid-template-columns:1fr 2fr">
        <div class="card pad-lg"><div class="card-head"><h3>Score trend</h3></div><div style="display:grid;place-items:center;padding:8px">${ring(88, 120, 12)}</div><div class="row between text-sm muted mt-4"><span>Last 30 runs</span><span class="badge success">▲ 3.2</span></div></div>
        <div class="card" style="padding:0"><div class="card-head" style="padding:16px 16px 0"><h3>Recent runs</h3></div><div class="table-wrap"><table class="tbl">
          <thead><tr><th>Eval</th><th>Agent</th><th>Cases</th><th>Score</th><th>Result</th><th>When</th></tr></thead>
          <tbody>${runs.map((r) => `<tr><td class="fw-600">${esc(r.name)}</td><td class="muted">${esc(r.agent)}</td><td class="mono">${r.cases}</td><td><div class="row gap-2">${r.score}<span class="meter"><span style="width:${r.score}%;background:${r.pass ? "var(--success)" : "var(--error)"}"></span></span></div></td><td>${r.pass ? statusBadge("completed") : `<span class="badge error"><span class="dot"></span>Failed</span>`}</td><td class="muted nowrap">${timeAgo(r.at)}</td></tr>`).join("")}</tbody>
        </table></div></div>
      </div>`;
  },
};

/* ---------- shared mini stat ---------- */
function statMini(label, value, ic) {
  return `<div class="stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ico">${icon(ic)}</span></div><div class="stat-value" style="font-size:26px">${value}</div></div>`;
}

/* ============================================================
   Backend-aware helpers (MCP + Integrations)
   ============================================================ */
function demoNote(txt) {
  return `<div class="alert info mb-4"><span class="a-ico">${icon("info")}</span><div class="a-body"><div class="a-title">Demo mode — no backend</div><div class="a-desc">${esc(txt)}</div></div></div>`;
}
function loadingCard(txt) {
  return `<div class="card"><div class="row gap-2"><div class="spinner"></div><span class="muted">${esc(txt)}</span></div></div>`;
}
function errCard(msg) {
  return `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Request failed</div><div class="a-desc">${esc(msg)}</div></div></div>`;
}

/* ---- MCP ---- */
function mcpRowHTML(m) {
  const count = Array.isArray(m.tools) ? m.tools.length : (m.tools || 0);
  const active = m.status === "active";
  const badge = active ? `<span class="badge success"><span class="dot"></span>Active</span>`
    : m.status === "error" ? `<span class="badge error"><span class="dot"></span>Error</span>`
    : `<span class="badge neutral">Stopped</span>`;
  return `<tr>
    <td><div class="cell-main"><div class="aico" style="background:${store.colors.blue};width:30px;height:30px">${icon("mcp")}</div><div class="stack"><span class="fw-600">${esc(m.name)}</span><span class="cell-sub">${esc(m.desc || m.kind || "")}</span></div></div></td>
    <td>${badge}</td>
    <td class="mono">${count}</td>
    <td><div class="row gap-2">
      ${active ? `<button class="btn sm btn-secondary" data-mcpstop="${m.id}">Stop</button>` : `<button class="btn sm btn-primary" data-mcpstart="${m.id}">Start</button>`}
      ${active && count ? `<button class="btn sm btn-ghost" data-mcptools="${m.id}">${icon("tools")}Tools</button>` : ""}
      ${m.kind === "custom" ? `<button class="icon-btn" data-mcpdel="${m.id}" title="Delete">${icon("trash")}</button>` : ""}
    </div></td>
  </tr>`;
}
function mcpTableHTML(rows) {
  return `<div class="card" style="padding:0"><div class="table-wrap"><table class="tbl"><thead><tr><th>Server</th><th>Status</th><th>Tools</th><th>Actions</th></tr></thead><tbody id="mcpRows">${rows.map(mcpRowHTML).join("")}</tbody></table></div></div>`;
}
async function mcpMountReal(root) {
  const body = root.querySelector("#mcpBody");
  let servers = [];
  try { servers = await api.mcp.list(); } catch (e) { body.innerHTML = errCard(e.message); return; }
  body.innerHTML = mcpTableHTML(servers);
  root.querySelectorAll("[data-mcpstart]").forEach((b) => (b.onclick = async () => {
    b.classList.add("loading");
    try { const r = await api.mcp.connect(b.dataset.mcpstart); toast("success", "Server started", (r.tools?.length || 0) + " tools discovered"); }
    catch (e) { toast("error", "Start failed", e.message); }
    rerender();
  }));
  root.querySelectorAll("[data-mcpstop]").forEach((b) => (b.onclick = async () => {
    try { await api.mcp.disconnect(b.dataset.mcpstop); toast("info", "Server stopped"); } catch (e) { toast("error", "Stop failed", e.message); }
    rerender();
  }));
  root.querySelectorAll("[data-mcpdel]").forEach((b) => (b.onclick = () => confirmDialog({
    title: "Delete MCP server", message: "Remove this server definition?", confirmText: "Delete",
    onConfirm: async () => { try { await api.mcp.remove(b.dataset.mcpdel); toast("success", "Server removed"); rerender(); } catch (e) { toast("error", "Failed", e.message); } },
  })));
  root.querySelectorAll("[data-mcptools]").forEach((b) => (b.onclick = () => openToolRunner(servers.find((s) => s.id === b.dataset.mcptools))));
  wireAddMcp(root, true);
}
function openToolRunner(server) {
  const tools = server.tools || [];
  openModal({
    title: "Run tool · " + server.name, width: 540,
    body: `<div class="field"><label class="label">Tool</label><select class="select" id="trTool">${tools.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.description ? " — " + esc(t.description) : ""}</option>`).join("")}</select></div>
      <div class="field"><label class="label">Arguments (JSON)</label><textarea class="textarea mono" id="trArgs" rows="3">{}</textarea></div>
      <div id="trResult"></div>`,
    footer: `<button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="trRun">${icon("play")}Run</button>`,
    onMount: (m) => (m.querySelector("#trRun").onclick = async () => {
      let args = {};
      try { args = JSON.parse(m.querySelector("#trArgs").value || "{}"); } catch { return toast("error", "Arguments must be valid JSON"); }
      const btn = m.querySelector("#trRun"); btn.classList.add("loading");
      try {
        const r = await api.mcp.call(server.id, m.querySelector("#trTool").value, args);
        const text = (r.result?.content || []).map((c) => c.text).filter(Boolean).join("\n");
        m.querySelector("#trResult").innerHTML = `<div class="section-title">Result</div><div class="codeblock"><pre>${esc(text || JSON.stringify(r.result, null, 2))}</pre></div>`;
      } catch (e) { toast("error", "Call failed", e.message); }
      btn.classList.remove("loading");
    }),
  });
}
function wireAddMcp(root, real) {
  const add = root.querySelector("#addMcp");
  if (!add) return;
  add.onclick = () => openModal({
    title: "Add MCP server", width: 540,
    body: `<div class="field"><label class="label">Name</label><input class="input" id="mn" placeholder="my-server"/></div>
      <div class="field"><label class="label">Command</label><input class="input mono" id="mcmd" placeholder="npx"/></div>
      <div class="field"><label class="label">Arguments (space-separated)</label><input class="input mono" id="marg" placeholder="-y @modelcontextprotocol/server-filesystem ."/></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="mok">${icon("plus")}Add server</button>`,
    onMount: (m) => (m.querySelector("#mok").onclick = async () => {
      const name = m.querySelector("#mn").value.trim(), command = m.querySelector("#mcmd").value.trim();
      if (!name || !command) return toast("error", "Name and command required");
      const args = m.querySelector("#marg").value.trim();
      try {
        if (real) await api.mcp.add({ name, command, args });
        else store.set((s) => s.mcpServers.push({ id: store.uid(), name, cmd: command + " " + args, status: "idle", tools: 0 }));
        closeOverlay(); toast("success", "Server added", name); rerender();
      } catch (e) { toast("error", "Add failed", e.message); }
    }),
  });
}
function mcpMountLocal(root) {
  const view = root.closest ? root : root;
  root.querySelectorAll("[data-mcpstart],[data-mcpstop]").forEach((b) => {
    const id = b.dataset.mcpstart || b.dataset.mcpstop;
    b.onclick = () => { store.set((s) => { const m = s.mcpServers.find((x) => x.id === id); m.status = m.status === "active" ? "idle" : "active"; }); rerender(); };
  });
  root.querySelectorAll("[data-mcpdel]").forEach((b) => (b.onclick = () => { store.set((s) => (s.mcpServers = s.mcpServers.filter((x) => x.id !== b.dataset.mcpdel))); rerender(); }));
  wireAddMcp(root, false);
}

/* ---- Integrations ---- */
function intCardLocal(i) {
  return `<div class="card tile"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors[i.color]}">${icon(i.icon)}</div><div class="stack"><span class="fw-700">${esc(i.name)}</span><span class="hint">${esc(i.desc)}</span></div></div></div>
    <div class="row between mt-4">${i.connected ? `<span class="badge success"><span class="dot"></span>Connected</span>` : `<span class="badge neutral">Not connected</span>`}<button class="btn sm ${i.connected ? "btn-secondary" : "btn-primary"}" data-int="${i.id}">${i.connected ? "Disconnect" : "Connect"}</button></div></div>`;
}
function intMountLocal(root) {
  root.querySelectorAll("[data-int]").forEach((b) => (b.onclick = () => {
    const i = store.state.integrations.find((x) => x.id === b.dataset.int);
    store.set((s) => (s.integrations.find((x) => x.id === b.dataset.int).connected = !i.connected));
    toast(i.connected ? "info" : "success", (i.connected ? "Disconnected " : "Connected ") + i.name); rerender();
  }));
}
function intCardReal(i) {
  return `<div class="card tile" data-intcard="${i.provider}"><div class="row between"><div class="row gap-3"><div class="aico" style="background:${store.colors[i.color] || store.colors.violet}">${icon(i.icon)}</div><div class="stack"><span class="fw-700">${esc(i.name)}</span><span class="hint">${esc(i.desc)}</span></div></div></div>
    ${i.lastResult ? `<div class="hint mt-2">${i.lastResult.ok ? "✓" : "✕"} ${esc(i.lastResult.detail || "")}</div>` : ""}
    <div class="row between mt-4">${i.connected ? `<span class="badge success"><span class="dot"></span>Connected</span>` : `<span class="badge neutral">Not connected</span>`}
      <div class="row gap-2">${i.connected && i.provider === "slack" ? `<button class="btn sm btn-ghost" data-intsend="${i.provider}">Send test</button>` : ""}${i.connected && i.provider === "mila" ? `<button class="btn sm btn-ghost" data-intstatus="mila">Status</button><button class="btn sm btn-primary" data-intcode="mila">New code</button>` : ""}<button class="btn sm ${i.connected ? "btn-secondary" : "btn-primary"}" data-intbtn="${i.provider}">${i.connected ? "Disconnect" : "Connect"}</button></div>
    </div></div>`;
}
async function intMountReal(root) {
  const body = root.querySelector("#intBody");
  let list = [];
  try { list = await api.integrations.list(); } catch (e) { body.innerHTML = errCard(e.message); return; }
  body.innerHTML = `<div class="grid cols-3">${list.map(intCardReal).join("")}</div>`;
  list.forEach((i) => {
    const card = body.querySelector(`[data-intcard="${i.provider}"]`); if (!card) return;
    card.querySelector("[data-intbtn]").onclick = () => (i.connected ? intDisconnect(i) : intConnect(i));
    const send = card.querySelector("[data-intsend]");
    if (send) send.onclick = async () => { try { await api.integrations.slackSend("Test message from Agentic OS ✅"); toast("success", "Sent to Slack"); } catch (e) { toast("error", "Send failed", e.message); } };
    const status = card.querySelector("[data-intstatus]");
    if (status) status.onclick = async () => {
      try {
        const s = await api.integrations.milaStatus();
        toast(s.voiceConfigured ? "success" : "info", "MILA Voice", s.voiceConfigured ? `Ready · ${s.liveModel}` : "Backend online · Gemini key missing");
      } catch (e) { toast("error", "MILA status failed", e.message); }
    };
    const code = card.querySelector("[data-intcode]");
    if (code) code.onclick = () => openMilaCode();
  });
}
function openMilaCode() {
  openModal({
    title: "Connect MILA mobile app", width: 460,
    body: `<div class="field"><label class="label">Account label</label><input class="input" id="milaLabel" placeholder="Name or email"/></div><div id="milaCodeResult" class="mt-3"></div>`,
    footer: `<button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="milaCreateCode">Create one-time code</button>`,
    onMount: (m) => (m.querySelector("#milaCreateCode").onclick = async () => {
      const btn = m.querySelector("#milaCreateCode"); btn.classList.add("loading");
      try {
        const result = await api.integrations.milaConnectionCode(m.querySelector("#milaLabel").value.trim() || "MILA user");
        m.querySelector("#milaCodeResult").innerHTML = `<div class="alert success"><span class="a-ico">${icon("key")}</span><div class="a-body"><div class="a-title mono" style="font-size:22px;letter-spacing:3px">${esc(result.code)}</div><div class="a-desc">Enter in MILA → Settings → AI Providers. Expires in 10 minutes.</div></div></div>`;
      } catch (e) { m.querySelector("#milaCodeResult").innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Could not create code</div><div class="a-desc">${esc(e.message)}</div></div></div>`; }
      btn.classList.remove("loading");
    }),
  });
}
function intConnect(i) {
  openModal({
    title: "Connect " + i.name, width: 480,
    body: (i.fields || []).map((f) => `<div class="field"><label class="label">${esc(f.label)}</label><input class="input mono" id="if_${f.key}" ${f.secret ? 'type="password"' : ""} placeholder="${esc(f.label)}"/></div>`).join("") + `<div id="icErr"></div>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="icOk">${icon("lock")}Connect &amp; test</button>`,
    onMount: (m) => (m.querySelector("#icOk").onclick = async () => {
      const cfg = {}; (i.fields || []).forEach((f) => (cfg[f.key] = m.querySelector("#if_" + f.key).value.trim()));
      const btn = m.querySelector("#icOk"); btn.classList.add("loading");
      try {
        const r = await api.integrations.connect(i.provider, cfg);
        if (r.ok) { closeOverlay(); toast("success", "Connected " + i.name, r.detail); rerender(); }
        else m.querySelector("#icErr").innerHTML = `<div class="alert error"><span class="a-ico">${icon("x")}</span><div class="a-body"><div class="a-title">Connection failed</div><div class="a-desc">${esc(r.detail)}</div></div></div>`;
      } catch (e) { toast("error", "Error", e.message); }
      btn.classList.remove("loading");
    }),
  });
}
async function intDisconnect(i) {
  try { await api.integrations.disconnect(i.provider); toast("info", "Disconnected " + i.name); rerender(); }
  catch (e) { toast("error", "Failed", e.message); }
}
