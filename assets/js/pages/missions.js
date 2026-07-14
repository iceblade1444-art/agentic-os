import { icon } from "../icons.js";
import { api } from "../api.js";
import { esc, toast } from "../ui.js";
import { timeAgo } from "../store.js";

let selected = null;

const EVENT_META = {
  status: { ic: "activity", cls: "info" },
  think: { ic: "brain", cls: "primary" },
  tool_call: { ic: "zap", cls: "primary" },
  tool_result: { ic: "check", cls: "success" },
  tool_error: { ic: "warn", cls: "error" },
  error: { ic: "x", cls: "error" },
  assistant: { ic: "bot", cls: "neutral" },
  complete: { ic: "check", cls: "success" },
  log: { ic: "info", cls: "neutral" },
};
function eventHTML(e) {
  const m = EVENT_META[e.type] || EVENT_META.log;
  let extra = "";
  if (e.data != null) {
    const d = e.data.result !== undefined ? e.data.result : (typeof e.data === "object" ? JSON.stringify(e.data) : e.data);
    if (d) extra = `<span class="cell-sub mono">${esc(String(d).slice(0, 220))}</span>`;
  }
  return `<div class="row gap-3" style="padding:9px 0;border-bottom:1px solid var(--border);align-items:flex-start">
    <span class="badge ${m.cls}" style="flex:none">${icon(m.ic)}${e.type}</span>
    <div class="stack" style="min-width:0">${e.message ? `<span>${esc(e.message)}</span>` : ""}${extra}</div>
  </div>`;
}
const statusBadge = (s) => `<span class="badge ${s === "completed" ? "success" : s === "running" ? "warning" : s === "failed" ? "error" : "neutral"}">${s}</span>`;

export default {
  title: "Missions",
  render() {
    if (!api.on) {
      return `<div class="page-head"><div><div class="page-title">Missions</div><div class="page-sub">Give a mission; an orchestrator makes it real via Agentic OS.</div></div></div>
      <div class="alert info"><span class="a-ico">${icon("info")}</span><div class="a-body"><div class="a-title">Backend required</div><div class="a-desc">Missions need the Node backend. Run <span class="mono">npm start</span> and reload. Then either use the built-in OpenAI orchestrator, or drive missions from external <b>Hermes</b> via the <span class="mono">agentic-os</span> MCP bridge (see the README).</div></div></div>`;
    }
    return `
    <div class="page-head"><div><div class="page-title">Missions</div><div class="page-sub">Give a mission; Hermes or the built-in orchestrator makes it real using Agentic OS tools.</div></div></div>
    <div class="grid" style="grid-template-columns:380px 1fr;align-items:start">
      <div class="stack gap-4">
        <div class="card pad-lg">
          <div class="section-title">New mission</div>
          <div class="field"><label class="label">Title</label><input class="input" id="mTitle" placeholder="e.g. Add 21 + 21 with a tool"/></div>
          <div class="field"><label class="label">Goal</label><textarea class="textarea" id="mGoal" placeholder="Describe what to accomplish…"></textarea></div>
          <div class="field"><label class="label">Orchestrator</label><select class="select" id="mOrch"><option value="built-in">Built-in (OpenAI brain)</option><option value="hermes">Hermes (external agent)</option></select></div>
          <button class="btn btn-primary block" id="mLaunch">${icon("rocket")}Launch mission</button>
        </div>
        <div class="card pad-lg">
          <div class="section-title">Missions</div>
          <div id="mList" class="stack gap-2"><div class="row gap-2"><div class="spinner"></div><span class="muted">Loading…</span></div></div>
        </div>
      </div>
      <div class="card pad-lg" id="mDetail">
        <div class="empty"><div class="empty-ico">${icon("rocket")}</div><h4>No mission selected</h4><p>Launch a mission or pick one from the list to watch it execute live.</p></div>
      </div>
    </div>`;
  },

  mount(root) {
    if (!api.on) return;
    const listEl = root.querySelector("#mList");
    const detailEl = root.querySelector("#mDetail");

    async function refreshList() {
      let list = [];
      try { list = await api.missions.list(); } catch (e) { listEl.innerHTML = `<span class="muted">${esc(e.message)}</span>`; return; }
      if (!list.length) { listEl.innerHTML = `<span class="dim text-sm">No missions yet.</span>`; return; }
      listEl.innerHTML = list.map((m) => `<button class="wf-node-btn" data-mid="${m.id}" style="width:100%${m.id === selected ? ";border-color:var(--primary)" : ""}">
        <span class="status-dot" style="background:${m.status === "completed" ? "var(--success)" : m.status === "running" ? "var(--warning)" : m.status === "failed" ? "var(--error)" : "var(--text-3)"};flex:none"></span>
        <div class="stack" style="min-width:0"><span class="t">${esc(m.title)}</span><span class="d">${m.status} · ${m.events} events · ${timeAgo(m.createdAt)}</span></div></button>`).join("");
      listEl.querySelectorAll("[data-mid]").forEach((b) => (b.onclick = () => openMission(b.dataset.mid)));
    }

    async function openMission(id) {
      selected = id;
      let m;
      try { m = await api.missions.get(id); } catch { return; }
      renderDetail(m);
      refreshList();
    }

    function renderDetail(m) {
      detailEl.innerHTML = `
        <div class="row between mb-4"><div style="min-width:0"><div class="text-lg fw-700">${esc(m.title)}</div><div class="hint">${esc(m.goal || "")}</div></div>
          <div class="row gap-2">${m.status === "pending" ? `<button class="btn btn-primary sm" id="mRun">${icon("play")}Run</button>` : ""}<span id="mStatus">${statusBadge(m.status)}</span></div></div>
        ${m.orchestrator ? `<div class="hint mb-4">Orchestrator: <b>${esc(m.orchestrator)}</b></div>` : ""}
        <div class="section-title">Execution feed</div>
        <div id="mFeed" class="stack">${(m.events || []).map(eventHTML).join("") || `<span class="dim text-sm">No events yet — run the mission.</span>`}</div>`;
      const runBtn = detailEl.querySelector("#mRun");
      if (runBtn) runBtn.onclick = () => runMission(m.id);
    }

    async function runMission(id) {
      selected = id;
      const m = await api.missions.get(id);
      renderDetail({ ...m, status: "running" });
      const feed = detailEl.querySelector("#mFeed");
      const statusEl = detailEl.querySelector("#mStatus");
      feed.innerHTML = "";
      try {
        await api.missions.run(id, (e) => {
          feed.insertAdjacentHTML("beforeend", eventHTML(e));
          feed.scrollIntoView({ block: "nearest" });
          if (e.status && statusEl) statusEl.innerHTML = statusBadge(e.status);
        });
      } catch (e) { toast("error", "Run failed", e.message); }
      const fresh = await api.missions.get(id);
      renderDetail(fresh);
      refreshList();
    }

    root.querySelector("#mLaunch").onclick = async () => {
      const title = root.querySelector("#mTitle").value.trim();
      const goal = root.querySelector("#mGoal").value.trim();
      const orch = root.querySelector("#mOrch").value;
      if (!title && !goal) return toast("error", "Add a title or goal");
      let created;
      try { created = await api.missions.create({ title, goal, orchestrator: orch }); } catch (e) { return toast("error", "Failed", e.message); }
      root.querySelector("#mTitle").value = "";
      root.querySelector("#mGoal").value = "";
      selected = created.id;
      await refreshList();
      if (orch === "built-in") { toast("success", "Mission launched", "Running with the built-in orchestrator…"); runMission(created.id); }
      else { toast("success", "Mission queued for Hermes", "Hermes pulls it via list_missions and reports back here."); openMission(created.id); }
    };

    refreshList();
  },
};
