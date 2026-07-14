import { store, timeAgo } from "../store.js";
import { icon } from "../icons.js";
import {
  agentIcon, statusBadge, esc, toast, openModal, openDrawer, closeOverlay,
  openMenu, confirmDialog, qs, qsa, sparkline, randomSeries,
} from "../ui.js";

const TYPES = ["Conversational", "Workflow", "Tool-based", "Autonomous"];
const MODELS = ["GPT-4o", "GPT-4o mini", "Claude Opus 4.8", "Claude Sonnet 5", "Claude Haiku 4.5", "Llama 3.1 70B"];
const COLORS = ["violet", "blue", "green", "amber", "pink", "cyan"];
const ICONS = ["bot", "search", "code", "database", "edit", "mail", "chat", "brain", "terminal", "sparkles"];

let filter = { q: "", status: "all" };

/* ---------- Create / edit modal ---------- */
export function openCreateAgent(existing) {
  const a = existing || { name: "", type: "Conversational", model: "gpt-4o", description: "", instructions: "", color: "violet", icon: "bot", tags: [] };
  const body = `
    <div class="field"><label class="label">Name</label><input class="input" id="f-name" placeholder="My New Agent" value="${esc(a.name)}"/></div>
    <div class="grid cols-2">
      <div class="field"><label class="label">Type</label><select class="select" id="f-type">${TYPES.map((t) => `<option ${t === a.type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="field"><label class="label">Model</label><select class="select" id="f-model">${MODELS.map((m) => `<option ${m === a.model ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label class="label">Description</label><textarea class="textarea" id="f-desc" placeholder="Describe what your agent does…">${esc(a.description)}</textarea></div>
    <div class="field"><label class="label">Instructions</label><textarea class="textarea" id="f-inst" placeholder="You are a helpful assistant…">${esc(a.instructions)}</textarea></div>
    <div class="grid cols-2">
      <div class="field"><label class="label">Accent</label><div class="row gap-2" id="f-colors">${COLORS.map((c) => `<button type="button" class="color-swatch ${c === a.color ? "sel" : ""}" data-c="${c}" style="width:26px;height:26px;border-radius:8px;border:2px solid ${c === a.color ? "var(--primary)" : "transparent"};background:${store.colors[c]}"></button>`).join("")}</div></div>
      <div class="field"><label class="label">Icon</label><select class="select" id="f-icon">${ICONS.map((i) => `<option ${i === a.icon ? "selected" : ""}>${i}</option>`).join("")}</select></div>
    </div>`;
  const footer = `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="f-save">${icon(existing ? "save" : "plus")}${existing ? "Save changes" : "Create agent"}</button>`;

  openModal({
    title: existing ? "Edit agent" : "Create new agent", width: 540, body, footer,
    onMount: (m) => {
      let color = a.color;
      m.querySelectorAll(".color-swatch").forEach((b) => (b.onclick = () => {
        color = b.dataset.c;
        m.querySelectorAll(".color-swatch").forEach((x) => (x.style.borderColor = "transparent"));
        b.style.borderColor = "var(--primary)";
      }));
      m.querySelector("#f-save").onclick = () => {
        const name = m.querySelector("#f-name").value.trim();
        if (!name) { m.querySelector("#f-name").classList.add("error"); toast("error", "Name is required"); return; }
        const data = {
          name, type: m.querySelector("#f-type").value, model: m.querySelector("#f-model").value,
          description: m.querySelector("#f-desc").value.trim(), instructions: m.querySelector("#f-inst").value.trim(),
          color, icon: m.querySelector("#f-icon").value,
        };
        store.set((s) => {
          if (existing) { Object.assign(s.agents.find((x) => x.id === existing.id), data); }
          else {
            s.agents.unshift({ id: store.uid("agt"), ...data, status: "active", tasks: 0, successRate: 100, lastRun: Date.now(), cpu: 0, mem: 0, tags: [], tools: [], createdAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) });
          }
        });
        closeOverlay();
        toast("success", existing ? "Agent updated" : "Agent created", name);
        if (location.hash.replace(/^#\/?/, "").startsWith("agents") || location.hash === "" || location.hash === "#/") {
          import("../app.js"); // ensure loaded
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }
      };
    },
  });
}

/* ---------- Detail drawer ---------- */
export function openAgentDrawer(id) {
  const a = store.state.agents.find((x) => x.id === id);
  if (!a) return;
  openDrawer({
    title: "Agent details",
    body: `
      <div class="row gap-3 mb-4">${agentIcon(a, 48)}<div class="stack"><span class="text-lg fw-700">${esc(a.name)}</span><span class="muted">${esc(a.type)} Agent</span></div><div class="spacer"></div>${statusBadge(a.status)}</div>
      <p class="muted mb-4">${esc(a.description || "No description.")}</p>
      <div class="card" style="background:var(--surface-2);margin-bottom:16px">
        ${row("ID", `<span class="mono text-sm">${a.id}</span>`)}
        ${row("Model", a.model)}
        ${row("Created", a.createdAt || "—")}
        ${row("Tasks", a.tasks)}
        ${row("Success rate", a.successRate + "%")}
        ${row("Tools", (a.tools?.length || 0) + " tools")}
        ${row("Tags", (a.tags || []).map((t) => `<span class="badge neutral">${esc(t)}</span>`).join(" ") || "—")}
      </div>
      <div class="section-title">Instructions</div>
      <div class="codeblock" style="margin-bottom:16px"><pre>${esc(a.instructions || "—")}</pre></div>
      <div class="row gap-2">
        <button class="btn btn-primary" id="d-run">${icon("play")}Run</button>
        <button class="btn btn-secondary" id="d-edit">${icon("edit")}Edit</button>
        <div class="spacer"></div>
        <button class="btn btn-ghost" id="d-del" style="color:var(--error)">${icon("trash")}Delete</button>
      </div>`,
    onMount: (d) => {
      d.querySelector("#d-run").onclick = () => { toast("success", "Agent run started", a.name); };
      d.querySelector("#d-edit").onclick = () => { closeOverlay(); openCreateAgent(a); };
      d.querySelector("#d-del").onclick = () => { closeOverlay(); deleteAgent(a.id); };
    },
  });
}
const row = (k, v) => `<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--border)"><span class="muted text-sm">${k}</span><span class="fw-600">${v}</span></div>`;

function deleteAgent(id) {
  const a = store.state.agents.find((x) => x.id === id);
  confirmDialog({
    title: "Delete agent", message: `Are you sure you want to delete “${a.name}”? This action cannot be undone.`,
    confirmText: "Delete", onConfirm: () => {
      store.set((s) => { s.agents = s.agents.filter((x) => x.id !== id); });
      toast("success", "Agent deleted", a.name);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    },
  });
}

/* ---------- Page ---------- */
export default {
  title: "Agents",
  render() {
    const s = store.state;
    let list = s.agents;
    if (filter.status !== "all") list = list.filter((a) => a.status === filter.status);
    if (filter.q) list = list.filter((a) => (a.name + a.type + a.model).toLowerCase().includes(filter.q.toLowerCase()));

    return `
    <div class="page-head">
      <div><div class="page-title">Agents</div><div class="page-sub">${s.agents.length} agents · ${s.agents.filter((a) => a.status === "active").length} active</div></div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="newAgent">${icon("plus")}New agent</button>
    </div>

    <div class="card" style="padding:0">
      <div class="row gap-3 wrap" style="padding:14px 16px;border-bottom:1px solid var(--border)">
        <div class="search" style="max-width:320px;flex:1"><span>${icon("search")}</span><input id="agentSearch" placeholder="Search agents…" value="${esc(filter.q)}"/></div>
        <div class="pill-tabs" id="statusFilter">
          ${["all", "active", "running", "error"].map((st) => `<button class="${filter.status === st ? "active" : ""}" data-s="${st}">${st[0].toUpperCase() + st.slice(1)}</button>`).join("")}
        </div>
        <div class="spacer"></div>
        <span class="dim text-sm">${list.length} shown</span>
      </div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th class="sortable" data-k="name">Name</th><th>Status</th><th>Type</th><th>Model</th>
            <th class="sortable" data-k="tasks">Tasks</th><th class="sortable" data-k="successRate">Success</th><th>Last run</th><th></th>
          </tr></thead>
          <tbody id="agentRows">
            ${list.length ? list.map((a) => rowHTML(a)).join("") : `<tr><td colspan="8">${emptyRow()}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  },

  mount(root) {
    root.querySelector("#newAgent").onclick = () => openCreateAgent();
    const search = root.querySelector("#agentSearch");
    search.oninput = (e) => { filter.q = e.target.value; refresh(root); };
    root.querySelectorAll("#statusFilter button").forEach((b) => (b.onclick = () => { filter.status = b.dataset.s; window.dispatchEvent(new HashChangeEvent("hashchange")); }));
    wireRows(root);
  },
};

function rowHTML(a) {
  return `<tr data-id="${a.id}" style="cursor:pointer">
    <td><div class="cell-main">${agentIcon(a, 32)}<div class="stack"><span class="fw-600">${esc(a.name)}</span><span class="cell-sub">${(a.tags || []).slice(0, 2).join(", ")}</span></div></div></td>
    <td>${statusBadge(a.status)}</td>
    <td class="muted">${esc(a.type)}</td>
    <td class="muted">${esc(a.model)}</td>
    <td class="mono">${a.tasks}</td>
    <td><div class="row gap-2">${a.successRate}%<span class="meter"><span style="width:${a.successRate}%;background:${a.successRate > 95 ? "var(--success)" : a.successRate > 88 ? "var(--warning)" : "var(--error)"}"></span></span></div></td>
    <td class="muted nowrap">${timeAgo(a.lastRun)}</td>
    <td><button class="icon-btn row-menu" data-id="${a.id}">${icon("more")}</button></td>
  </tr>`;
}
function emptyRow() {
  return `<div class="empty"><div class="empty-ico">${icon("agents")}</div><h4>No agents found</h4><p>Try adjusting your search or filters.</p></div>`;
}
function refresh(root) {
  const s = store.state; let list = s.agents;
  if (filter.status !== "all") list = list.filter((a) => a.status === filter.status);
  if (filter.q) list = list.filter((a) => (a.name + a.type + a.model).toLowerCase().includes(filter.q.toLowerCase()));
  const tb = root.querySelector("#agentRows");
  tb.innerHTML = list.length ? list.map((a) => rowHTML(a)).join("") : `<tr><td colspan="8">${emptyRow()}</td></tr>`;
  wireRows(root);
}
function wireRows(root) {
  root.querySelectorAll("#agentRows tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", (e) => { if (e.target.closest(".row-menu")) return; openAgentDrawer(tr.dataset.id); });
  });
  root.querySelectorAll(".row-menu").forEach((btn) => (btn.onclick = (e) => {
    e.stopPropagation();
    const id = btn.dataset.id; const a = store.state.agents.find((x) => x.id === id);
    openMenu(btn, [
      { text: "View details", icon: "eye", onClick: () => openAgentDrawer(id) },
      { text: "Run agent", icon: "play", onClick: () => toast("success", "Agent run started", a.name) },
      { text: "Edit", icon: "edit", onClick: () => openCreateAgent(a) },
      { text: a.status === "active" ? "Pause" : "Activate", icon: a.status === "active" ? "pause" : "play", onClick: () => { store.set((s) => { s.agents.find((x) => x.id === id).status = a.status === "active" ? "paused" : "active"; }); window.dispatchEvent(new HashChangeEvent("hashchange")); } },
      { sep: true },
      { text: "Delete", icon: "trash", danger: true, onClick: () => deleteAgent(id) },
    ]);
  }));
}
