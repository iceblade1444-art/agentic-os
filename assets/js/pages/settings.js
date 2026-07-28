import { store } from "../store.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { toast, esc, confirmDialog } from "../ui.js";
import { applyTheme } from "../app.js";
import { localizedDate, t } from "../i18n.js";

const PROVIDERS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5-20251001" },
  compatible: { label: "OpenAI-compatible (local / proxy)", baseUrl: "http://localhost:1234/v1", model: "local-model" },
};

let tab = "appearance";
let teamUsers = null;
let teamError = "";
let securityState = null;
let securityError = "";

export default {
  title: "Settings",
  render() {
    const s = store.state;
    const llm = s.settings.llm;
    const tabs = api.auth.canAdmin
      ? [["appearance", t("settings.appearance")], ["model", t("settings.model")], ["profile", t("settings.profile")], ["security", t("settings.security")], ["team", t("settings.team")], ["workspace", t("settings.workspace")], ["data", t("settings.data")]]
      : [["appearance", t("settings.appearance")], ["profile", t("settings.profile")], ["security", t("settings.security")], ["workspace", t("settings.assistant")]];
    if (!tabs.some(([key]) => key === tab)) tab = "appearance";
    return `
    <div class="page-head"><div><div class="page-title">${t("settings.title")}</div><div class="page-sub">${t(api.auth.canAdmin ? "settings.adminSubtitle" : "settings.memberSubtitle")}</div></div></div>
    <div class="tabs mb-4" id="setTabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
    <div id="setBody" style="max-width:720px">${section(s, llm)}</div>`;
  },
  mount(root) {
    root.querySelectorAll("#setTabs .tab").forEach((b) => (b.onclick = () => { tab = b.dataset.t; window.dispatchEvent(new HashChangeEvent("hashchange")); }));
    wire(root);
    if (tab === "team" && teamUsers === null) loadTeam();
    if (tab === "security" && securityState === null) loadSecurity();
  },
};

function section(s, llm) {
  if (tab === "appearance") return `
    <div class="card pad-lg">
      <div class="section-title">${t("settings.theme")}</div>
      <div class="row gap-3 mb-4">
        <button class="btn ${s.settings.theme === "dark" ? "btn-primary" : "btn-secondary"}" data-theme="dark">${icon("moon")}${t("settings.dark")}</button>
        <button class="btn ${s.settings.theme === "light" ? "btn-primary" : "btn-secondary"}" data-theme="light">${icon("sun")}${t("settings.light")}</button>
      </div>
      <div class="row between" style="padding:12px 0;border-top:1px solid var(--border)">
        <div><div class="fw-600">${t("settings.compact")}</div><div class="hint">${t("settings.compactText")}</div></div>
        <label class="switch"><input type="checkbox" id="compact" ${s.settings.compact ? "checked" : ""}/><span class="track"></span><span class="thumb"></span></label>
      </div>
    </div>`;

  if (tab === "model") return `
    <div class="card pad-lg">
      ${api.on ? `<div class="alert success mb-4"><span class="a-ico">${icon("check")}</span><div class="a-body"><div class="a-title">${t("settings.backendConnected")}</div><div class="a-desc">${t(api.serverHasLLM() ? "settings.backendKey" : "settings.backendNoKey")} ${t("settings.backendBlank")}</div></div></div>` : ""}
      <div class="section-title">${t("settings.modelConnection")}</div>
      <p class="hint mb-4">${t("settings.modelText")}</p>
      <div class="field"><label class="label">${t("settings.provider")}</label>
        <select class="select" id="provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${llm.provider === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
      </div>
      <div class="field"><label class="label">${t("settings.baseUrl")}</label><input class="input mono" id="baseUrl" value="${esc(llm.baseUrl)}"/></div>
      <div class="field"><label class="label">${t("settings.apiKey")}</label><input class="input mono" id="apiKey" type="password" placeholder="sk-…" value="${esc(llm.apiKey)}"/><span class="hint">${t("settings.browserOnly")}</span></div>
      <div class="field"><label class="label">${t("settings.model")}</label><input class="input mono" id="model" value="${esc(llm.model)}"/></div>
      <div class="row gap-2 mt-2">
        <button class="btn btn-primary" id="saveModel">${icon("save")}${t("settings.saveConnection")}</button>
        <button class="btn btn-secondary" id="testModel">${icon("zap")}${t("settings.testConnection")}</button>
      </div>
    </div>`;

  if (tab === "profile") return `
    <div class="card pad-lg">
      <div class="section-title">${t("settings.signedAccount")}</div>
      <p class="hint mb-4">${t("settings.identityText")}</p>
      <div class="field"><label class="label">${t("settings.name")}</label><input class="input" value="${esc(s.profile.name)}" readonly/></div>
      <div class="field"><label class="label">Email</label><input class="input" value="${esc(s.profile.email || t("settings.notSet"))}" readonly/></div>
      <div class="field"><label class="label">${t("settings.role")}</label><input class="input" value="${esc(s.profile.role)}" readonly/></div>
    </div>`;

  if (tab === "security") return securitySection();

  if (tab === "team") return teamSection();

  if (tab === "workspace") return `
    <div class="card pad-lg">
      <div class="section-title">${t(api.auth.canAdmin ? "settings.workspaceContext" : "settings.milaPreferences")}</div>
      <p class="hint mb-4">${t(api.auth.canAdmin ? "settings.workspaceText" : "settings.preferencesText")}</p>
      <a class="btn btn-primary" href="/?setup=1">${icon("settings")}${t(api.auth.canAdmin ? "settings.reviewSetup" : "settings.editPreferences")}</a>
    </div>`;

  return `
    <div class="card pad-lg">
      <div class="section-title">${t("settings.data")}</div>
      <p class="hint mb-4">${t("settings.dataText")}</p>
      <div class="row gap-2">
        <button class="btn btn-secondary" id="exportData">${icon("upload")}${t("settings.export")}</button>
        <button class="btn btn-outline" id="resetData" style="color:var(--error);border-color:var(--error)">${icon("refresh")}${t("settings.resetDemo")}</button>
      </div>
    </div>`;
}

function securitySection() {
  if (securityError) return `<div class="alert error"><span class="a-ico">${icon("alert")}</span><div class="a-body"><div class="a-title">${t("settings.sessionsFailed")}</div><div class="a-desc">${esc(securityError)}</div></div></div>`;
  if (!securityState) return `<div class="card pad-lg"><div class="row gap-2">${icon("refresh")}<span>${t("settings.sessionsLoading")}</span></div></div>`;
  const deviceSessions = securityState.sessions || [];
  return `<div class="card pad-lg">
    <div class="row between mb-4">
      <div><div class="section-title">${t("settings.securityTitle")}</div><div class="hint">${t("settings.securityText")}</div></div>
      ${deviceSessions.length > 1 && !securityState.legacyCurrent ? `<button class="btn btn-outline sm" id="revokeOthers">${icon("lock")}${t("settings.revokeOthers")}</button>` : ""}
    </div>
    ${securityState.legacyCurrent ? `<div class="alert warning mb-4"><span class="a-ico">${icon("alert")}</span><div class="a-body"><div class="a-title">${t("settings.legacySession")}</div><div class="a-desc">${t("settings.legacySessionText")}</div></div></div>` : ""}
    ${deviceSessions.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>${t("settings.device")}</th><th>${t("settings.lastActive")}</th><th>${t("settings.access")}</th></tr></thead><tbody>
      ${deviceSessions.map((session) => `<tr>
        <td><div class="row gap-2"><span class="badge ${session.kind === "mobile" ? "primary" : "info"}">${t(session.kind === "mobile" ? "settings.mobileSession" : "settings.webSession")}</span>${session.current ? `<span class="badge success">${t("settings.currentSession")}</span>` : ""}</div><div class="cell-sub mt-1">${esc(session.label)}</div></td>
        <td><div>${localizedDate(session.lastSeenAt, { dateStyle: "medium", timeStyle: "short" })}</div><div class="cell-sub">${t("settings.expires")} ${localizedDate(session.expiresAt, { dateStyle: "medium" })}</div></td>
        <td><button class="btn btn-outline sm revoke-session" data-session-id="${esc(session.id)}" data-current="${session.current ? "true" : "false"}">${icon("x")}${t("settings.revoke")}</button></td>
      </tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state"><div class="empty-title">${t("settings.noSessions")}</div></div>`}
  </div>`;
}

function teamSection() {
  if (teamError) return `<div class="alert error"><span class="a-ico">${icon("alert")}</span><div class="a-body"><div class="a-title">${t("settings.teamFailed")}</div><div class="a-desc">${esc(teamError)}</div></div></div>`;
  if (!teamUsers) return `<div class="card pad-lg"><div class="row gap-2">${icon("refresh")}<span>${t("settings.teamLoading")}</span></div></div>`;
  return `<div class="card pad-lg">
    <div class="row between mb-4"><div><div class="section-title">${t("settings.workspaceTeam")}</div><div class="hint">${t("settings.teamText")}</div></div><span class="badge info">${t("settings.accountCount", { count: teamUsers.length })}</span></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>${t("settings.user")}</th><th>${t("settings.role")}</th><th>${t("settings.access")}</th></tr></thead><tbody>
      ${teamUsers.map((user) => `<tr>
        <td><div class="fw-600">${esc(user.name)}</div><div class="cell-sub">${esc(user.email || t("settings.serverOwner"))}</div></td>
        <td>${user.id === "creator" ? `<span class="badge primary">Creator</span>` : `<select class="select sm team-role" data-user-id="${esc(user.id)}" ${user.disabled ? "disabled" : ""}>${["Admin", "Member", "Viewer"].map((role) => `<option ${user.role === role ? "selected" : ""}>${role}</option>`).join("")}</select>`}</td>
        <td>${user.id === "creator" ? `<span class="badge success">${t("settings.permanent")}</span>` : `<button class="btn ${user.disabled ? "btn-secondary" : "btn-outline"} sm team-access" data-user-id="${esc(user.id)}" data-disabled="${user.disabled ? "true" : "false"}">${icon(user.disabled ? "check" : "lock")}${t(user.disabled ? "settings.enable" : "settings.disable")}</button>`}</td>
      </tr>`).join("")}
    </tbody></table></div>
  </div>`;
}

async function loadSecurity() {
  try { securityState = await api.auth.sessions(); securityError = ""; }
  catch (error) { securityState = { sessions: [] }; securityError = error.message || "Unknown error"; }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

async function loadTeam() {
  try { teamUsers = await api.auth.users(); teamError = ""; }
  catch (error) { teamUsers = []; teamError = error.message || "Unknown error"; }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function wire(root) {
  root.querySelectorAll("[data-theme]").forEach((b) => (b.onclick = () => { applyTheme(b.dataset.theme); window.dispatchEvent(new HashChangeEvent("hashchange")); }));
  const compact = root.querySelector("#compact");
  if (compact) compact.onchange = () => { store.set((s) => (s.settings.compact = compact.checked)); document.body.classList.toggle("compact", compact.checked); toast("success", t("settings.preferenceSaved")); };

  const save = root.querySelector("#saveModel");
  if (save) {
    const prov = root.querySelector("#provider");
    prov.onchange = () => { const p = PROVIDERS[prov.value]; root.querySelector("#baseUrl").value = p.baseUrl; root.querySelector("#model").value = p.model; };
    save.onclick = () => {
      store.set((s) => { s.settings.llm = { provider: prov.value, baseUrl: root.querySelector("#baseUrl").value.trim(), apiKey: root.querySelector("#apiKey").value.trim(), model: root.querySelector("#model").value.trim() }; });
      toast("success", t("settings.connectionSaved"), t(root.querySelector("#apiKey").value ? "settings.liveEnabled" : "settings.demoWithoutKey"));
    };
    root.querySelector("#testModel").onclick = async () => {
      const key = root.querySelector("#apiKey").value.trim();
      if (!key) return toast("warning", t("settings.noKey"), t("settings.addKeyFirst"));
      const btn = root.querySelector("#testModel"); btn.classList.add("loading");
      try {
        const base = root.querySelector("#baseUrl").value.trim().replace(/\/$/, "");
        const res = await fetch(base + "/models", { headers: { Authorization: "Bearer " + key } });
        toast(res.ok ? "success" : "error", res.ok ? t("settings.connectionOk") : t("settings.httpFailed", { status: res.status }), res.ok ? t("settings.providerReachable") : t("settings.checkConnection"));
      } catch (e) { toast("error", t("settings.connectionFailed"), t("settings.corsHint")); }
      btn.classList.remove("loading");
    };
  }

  root.querySelectorAll(".team-role").forEach((select) => select.onchange = async () => {
    select.disabled = true;
    try { await api.auth.updateUser(select.dataset.userId, { role: select.value }); toast("success", t("settings.roleUpdated"), t("settings.sessionsRevoked")); teamUsers = null; loadTeam(); }
    catch (error) { toast("error", t("settings.roleFailed"), error.message); select.disabled = false; }
  });
  root.querySelectorAll(".team-access").forEach((button) => button.onclick = async () => {
    button.classList.add("loading");
    try { await api.auth.updateUser(button.dataset.userId, { disabled: button.dataset.disabled !== "true" }); toast("success", t("settings.accessUpdated")); teamUsers = null; loadTeam(); }
    catch (error) { toast("error", t("settings.accessFailed"), error.message); button.classList.remove("loading"); }
  });

  root.querySelectorAll(".revoke-session").forEach((button) => button.onclick = () => confirmDialog({
    title: t("settings.revokeTitle"),
    message: t("settings.revokeText"),
    confirmText: t("settings.revoke"),
    onConfirm: async () => {
      try {
        const result = await api.auth.revokeSession(button.dataset.sessionId);
        toast("success", t("settings.revoked"));
        if (result.currentRevoked) {
          await api.auth.logout().catch(() => {});
          location.reload();
          return;
        }
        securityState = null;
        loadSecurity();
      } catch (error) { toast("error", t("settings.revokeFailed"), error.message); }
    },
  }));
  const revokeOthers = root.querySelector("#revokeOthers");
  if (revokeOthers) revokeOthers.onclick = () => confirmDialog({
    title: t("settings.revokeOthersTitle"),
    message: t("settings.revokeOthersText"),
    confirmText: t("settings.revokeOthers"),
    onConfirm: async () => {
      try {
        const result = await api.auth.revokeOtherSessions();
        toast("success", t("settings.revokedOthers", { count: result.revoked }));
        securityState = null;
        loadSecurity();
      } catch (error) { toast("error", t("settings.revokeFailed"), error.message); }
    },
  });

  const ex = root.querySelector("#exportData");
  if (ex) ex.onclick = () => {
    const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "agentic-os-backup.json"; a.click();
    toast("success", t("settings.backupExported"));
  };
  const rd = root.querySelector("#resetData");
  if (rd) rd.onclick = () => confirmDialog({ title: t("settings.resetDemo"), message: t("settings.resetText"), confirmText: t("settings.reset"), onConfirm: () => { store.reset(); applyTheme(store.state.settings.theme); toast("success", t("settings.dataReset")); window.dispatchEvent(new HashChangeEvent("hashchange")); } });
}
