import { store } from "../store.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { toast, esc, confirmDialog } from "../ui.js";
import { applyTheme } from "../app.js";

const PROVIDERS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5-20251001" },
  compatible: { label: "OpenAI-compatible (local / proxy)", baseUrl: "http://localhost:1234/v1", model: "local-model" },
};

let tab = "appearance";
let teamUsers = null;
let teamError = "";

export default {
  title: "Settings",
  render() {
    const s = store.state;
    const llm = s.settings.llm;
    const tabs = [["appearance", "Appearance"], ["model", "Model"], ["profile", "Profile"], ["data", "Data"]];
    if (api.auth.canAdmin) tabs.splice(3, 0, ["team", "Team"]);
    if (!tabs.some(([key]) => key === tab)) tab = "appearance";
    return `
    <div class="page-head"><div><div class="page-title">Settings</div><div class="page-sub">Manage your workspace, model connection and appearance.</div></div></div>
    <div class="tabs mb-4" id="setTabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
    <div id="setBody" style="max-width:720px">${section(s, llm)}</div>`;
  },
  mount(root) {
    root.querySelectorAll("#setTabs .tab").forEach((b) => (b.onclick = () => { tab = b.dataset.t; window.dispatchEvent(new HashChangeEvent("hashchange")); }));
    wire(root);
    if (tab === "team" && teamUsers === null) loadTeam();
  },
};

function section(s, llm) {
  if (tab === "appearance") return `
    <div class="card pad-lg">
      <div class="section-title">Theme</div>
      <div class="row gap-3 mb-4">
        <button class="btn ${s.settings.theme === "dark" ? "btn-primary" : "btn-secondary"}" data-theme="dark">${icon("moon")}Dark</button>
        <button class="btn ${s.settings.theme === "light" ? "btn-primary" : "btn-secondary"}" data-theme="light">${icon("sun")}Light</button>
      </div>
      <div class="row between" style="padding:12px 0;border-top:1px solid var(--border)">
        <div><div class="fw-600">Compact mode</div><div class="hint">Reduce paddings and density.</div></div>
        <label class="switch"><input type="checkbox" id="compact" ${s.settings.compact ? "checked" : ""}/><span class="track"></span><span class="thumb"></span></label>
      </div>
    </div>`;

  if (tab === "model") return `
    <div class="card pad-lg">
      ${api.on ? `<div class="alert success mb-4"><span class="a-ico">${icon("check")}</span><div class="a-body"><div class="a-title">Backend connected</div><div class="a-desc">Chat uses the server LLM proxy${api.serverHasLLM() ? " — provider key detected in .env." : " — set OPENAI_API_KEY / ANTHROPIC_API_KEY in .env (recommended), or a key below."} Leaving the key below blank uses the server's keys and avoids browser CORS.</div></div></div>` : ""}
      <div class="section-title">Model connection</div>
      <p class="hint mb-4">Connect the chat + agents to an LLM. Keys set here are stored in your browser. Direct browser calls to providers may hit CORS — prefer the backend proxy (set keys in the server's .env) for production.</p>
      <div class="field"><label class="label">Provider</label>
        <select class="select" id="provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${llm.provider === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
      </div>
      <div class="field"><label class="label">Base URL</label><input class="input mono" id="baseUrl" value="${esc(llm.baseUrl)}"/></div>
      <div class="field"><label class="label">API Key</label><input class="input mono" id="apiKey" type="password" placeholder="sk-…" value="${esc(llm.apiKey)}"/><span class="hint">Stored only in this browser (localStorage).</span></div>
      <div class="field"><label class="label">Model</label><input class="input mono" id="model" value="${esc(llm.model)}"/></div>
      <div class="row gap-2 mt-2">
        <button class="btn btn-primary" id="saveModel">${icon("save")}Save connection</button>
        <button class="btn btn-secondary" id="testModel">${icon("zap")}Test connection</button>
      </div>
    </div>`;

  if (tab === "profile") return `
    <div class="card pad-lg">
      <div class="section-title">Signed-in account</div>
      <p class="hint mb-4">This identity comes from the authenticated server session and cannot be changed only in the browser.</p>
      <div class="field"><label class="label">Name</label><input class="input" value="${esc(s.profile.name)}" readonly/></div>
      <div class="field"><label class="label">Email</label><input class="input" value="${esc(s.profile.email || "Not set")}" readonly/></div>
      <div class="field"><label class="label">Role</label><input class="input" value="${esc(s.profile.role)}" readonly/></div>
    </div>`;

  if (tab === "team") return teamSection();

  return `
    <div class="card pad-lg">
      <div class="section-title">Data</div>
      <p class="hint mb-4">All app data (agents, workflows, chats, settings) is stored in your browser. Export a backup or reset to the seeded demo.</p>
      <div class="row gap-2">
        <button class="btn btn-secondary" id="exportData">${icon("upload")}Export JSON</button>
        <button class="btn btn-outline" id="resetData" style="color:var(--error);border-color:var(--error)">${icon("refresh")}Reset demo data</button>
      </div>
    </div>`;
}

function teamSection() {
  if (teamError) return `<div class="alert error"><span class="a-ico">${icon("alert")}</span><div class="a-body"><div class="a-title">Could not load team</div><div class="a-desc">${esc(teamError)}</div></div></div>`;
  if (!teamUsers) return `<div class="card pad-lg"><div class="row gap-2">${icon("refresh")}<span>Loading team...</span></div></div>`;
  return `<div class="card pad-lg">
    <div class="row between mb-4"><div><div class="section-title">Workspace team</div><div class="hint">New registrations start as Member. Role or access changes revoke existing sessions.</div></div><span class="badge info">${teamUsers.length} accounts</span></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>Access</th></tr></thead><tbody>
      ${teamUsers.map((user) => `<tr>
        <td><div class="fw-600">${esc(user.name)}</div><div class="cell-sub">${esc(user.email || "Server owner")}</div></td>
        <td>${user.id === "creator" ? `<span class="badge primary">Creator</span>` : `<select class="select sm team-role" data-user-id="${esc(user.id)}" ${user.disabled ? "disabled" : ""}>${["Admin", "Member", "Viewer"].map((role) => `<option ${user.role === role ? "selected" : ""}>${role}</option>`).join("")}</select>`}</td>
        <td>${user.id === "creator" ? `<span class="badge success">Permanent</span>` : `<button class="btn ${user.disabled ? "btn-secondary" : "btn-outline"} sm team-access" data-user-id="${esc(user.id)}" data-disabled="${user.disabled ? "true" : "false"}">${icon(user.disabled ? "check" : "lock")}${user.disabled ? "Enable" : "Disable"}</button>`}</td>
      </tr>`).join("")}
    </tbody></table></div>
  </div>`;
}

async function loadTeam() {
  try { teamUsers = await api.auth.users(); teamError = ""; }
  catch (error) { teamUsers = []; teamError = error.message || "Unknown error"; }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function wire(root) {
  root.querySelectorAll("[data-theme]").forEach((b) => (b.onclick = () => { applyTheme(b.dataset.theme); window.dispatchEvent(new HashChangeEvent("hashchange")); }));
  const compact = root.querySelector("#compact");
  if (compact) compact.onchange = () => { store.set((s) => (s.settings.compact = compact.checked)); document.body.classList.toggle("compact", compact.checked); toast("success", "Preference saved"); };

  const save = root.querySelector("#saveModel");
  if (save) {
    const prov = root.querySelector("#provider");
    prov.onchange = () => { const p = PROVIDERS[prov.value]; root.querySelector("#baseUrl").value = p.baseUrl; root.querySelector("#model").value = p.model; };
    save.onclick = () => {
      store.set((s) => { s.settings.llm = { provider: prov.value, baseUrl: root.querySelector("#baseUrl").value.trim(), apiKey: root.querySelector("#apiKey").value.trim(), model: root.querySelector("#model").value.trim() }; });
      toast("success", "Model connection saved", root.querySelector("#apiKey").value ? "Live responses enabled in Chat." : "No key set — Chat stays in demo mode.");
    };
    root.querySelector("#testModel").onclick = async () => {
      const key = root.querySelector("#apiKey").value.trim();
      if (!key) return toast("warning", "No API key", "Add a key first to test the live connection.");
      const btn = root.querySelector("#testModel"); btn.classList.add("loading");
      try {
        const base = root.querySelector("#baseUrl").value.trim().replace(/\/$/, "");
        const res = await fetch(base + "/models", { headers: { Authorization: "Bearer " + key } });
        toast(res.ok ? "success" : "error", res.ok ? "Connection OK" : "Failed (HTTP " + res.status + ")", res.ok ? "Provider reachable from browser." : "Check key / CORS / proxy.");
      } catch (e) { toast("error", "Connection failed", "Likely CORS — route via your backend."); }
      btn.classList.remove("loading");
    };
  }

  root.querySelectorAll(".team-role").forEach((select) => select.onchange = async () => {
    select.disabled = true;
    try { await api.auth.updateUser(select.dataset.userId, { role: select.value }); toast("success", "Role updated", "Existing sessions for this account were revoked."); teamUsers = null; loadTeam(); }
    catch (error) { toast("error", "Could not update role", error.message); select.disabled = false; }
  });
  root.querySelectorAll(".team-access").forEach((button) => button.onclick = async () => {
    button.classList.add("loading");
    try { await api.auth.updateUser(button.dataset.userId, { disabled: button.dataset.disabled !== "true" }); toast("success", "Access updated"); teamUsers = null; loadTeam(); }
    catch (error) { toast("error", "Could not update access", error.message); button.classList.remove("loading"); }
  });

  const ex = root.querySelector("#exportData");
  if (ex) ex.onclick = () => {
    const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "agentic-os-backup.json"; a.click();
    toast("success", "Backup exported");
  };
  const rd = root.querySelector("#resetData");
  if (rd) rd.onclick = () => confirmDialog({ title: "Reset demo data", message: "This clears all agents, workflows and chats and restores the seeded demo. Continue?", confirmText: "Reset", onConfirm: () => { store.reset(); applyTheme(store.state.settings.theme); toast("success", "Data reset"); window.dispatchEvent(new HashChangeEvent("hashchange")); } });
}
