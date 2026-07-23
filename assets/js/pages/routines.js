import { api } from "../api.js";
import { icon } from "../icons.js";
import { closeOverlay, confirmDialog, esc, openModal, toast } from "../ui.js";

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
let state = null;
let error = "";
let loading = false;

function head(actions = "") {
  return `<div class="page-head"><div><div class="page-title">Routines</div><div class="page-sub">Recurring Hermes work with skills, delivery and run history</div></div><div class="spacer"></div>${actions}</div>`;
}

function loadingCard(text) {
  return `<div class="card pad-lg"><div class="skeleton" style="height:18px;width:180px"></div><div class="skeleton mt-3" style="height:90px"></div><p class="hint mt-3">${esc(text)}</p></div>`;
}

function status(job) {
  if (job.paused || job.enabled === false || job.status === "paused") return "paused";
  if (job.last_status === "failed" || job.last_error) return "error";
  return "active";
}

function dateValue(value) {
  if (!value) return "Not yet";
  const timestamp = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function card(job) {
  const current = status(job);
  const profile = job.profile_name || job.profile || "default";
  const id = job.id || job.name;
  return `<article class="card routine-card">
    <div class="row between gap-2">
      <span class="badge ${current === "active" ? "success" : current === "error" ? "error" : "warning"}"><span class="dot"></span>${esc(current)}</span>
      <span class="badge neutral">${esc(profile)}</span>
    </div>
    <button class="routine-main" data-routine-runs="${esc(id)}" data-profile="${esc(profile)}">
      <strong>${esc(job.name || "Unnamed routine")}</strong>
      <span class="routine-prompt">${esc(job.prompt || (job.no_agent ? "Script-only routine" : "Skill-backed routine"))}</span>
    </button>
    <div class="routine-facts">
      <div><span>Schedule</span><strong class="mono">${esc(job.schedule || "Not set")}</strong></div>
      <div><span>Delivery</span><strong>${esc(job.deliver || "local")}</strong></div>
      <div><span>Next run</span><strong>${esc(dateValue(job.next_run_at || job.nextRunAt))}</strong></div>
    </div>
    ${(job.skills || []).length ? `<div class="row gap-2 wrap">${job.skills.map((skill) => `<span class="badge info">/${esc(skill)}</span>`).join("")}</div>` : ""}
    ${api.auth.canAdmin ? `<div class="routine-actions">
      <button class="icon-btn tip" data-routine-action="trigger" data-id="${esc(id)}" data-profile="${esc(profile)}" data-tip="Run now">${icon("play")}</button>
      <button class="icon-btn tip" data-routine-action="${current === "paused" ? "resume" : "pause"}" data-id="${esc(id)}" data-profile="${esc(profile)}" data-tip="${current === "paused" ? "Resume" : "Pause"}">${icon(current === "paused" ? "play" : "pause")}</button>
      <button class="icon-btn tip" data-routine-delete="${esc(id)}" data-profile="${esc(profile)}" data-name="${esc(job.name || "routine")}" data-tip="Delete">${icon("trash")}</button>
    </div>` : ""}
  </article>`;
}

function bodyHTML() {
  const jobs = state?.jobs || [];
  const active = jobs.filter((job) => status(job) === "active").length;
  const paused = jobs.filter((job) => status(job) === "paused").length;
  const failed = jobs.filter((job) => status(job) === "error").length;
  return `
    <div class="grid cols-4 mb-4">
      ${mini("Total routines", jobs.length, "calendar")}
      ${mini("Active", active, "check")}
      ${mini("Paused", paused, "pause")}
      ${mini("Needs attention", failed, "warn")}
    </div>
    ${jobs.length ? `<div class="grid cols-3">${jobs.map(card).join("")}</div>` : `<div class="empty routine-empty"><div class="empty-ico">${icon("calendar")}</div><h4>No routines yet</h4><p>Schedule a safe recurring task, attach a Hermes skill and choose where its verified result should be delivered.</p>${api.auth.canAdmin ? `<button class="btn btn-primary mt-3" id="routineEmptyNew">${icon("plus")}Create first routine</button>` : ""}</div>`}`;
}

function mini(label, value, ico) {
  return `<div class="stat"><div class="row between"><span class="stat-label">${esc(label)}</span><div class="stat-icon">${icon(ico)}</div></div><div class="stat-value">${esc(value)}</div></div>`;
}

const routines = {
  title: "Routines",
  render() {
    const actions = api.on ? `<button class="btn btn-secondary" id="routineRefresh">${icon("refresh")}Refresh</button>${api.auth.canAdmin ? `<button class="btn btn-primary" id="routineNew">${icon("plus")}New routine</button>` : ""}` : "";
    if (!api.on) return head(actions) + `<div class="alert warning"><div class="a-body"><div class="a-title">Backend required</div><div class="a-desc">Start Agentic OS to manage Hermes routines.</div></div></div>`;
    if (error) return head(actions) + `<div class="alert error"><div class="a-body"><div class="a-title">Routines unavailable</div><div class="a-desc">${esc(error)}</div></div></div>`;
    return head(actions) + (state ? bodyHTML() : loadingCard("Reading Hermes schedules…"));
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#routineRefresh")?.addEventListener("click", () => load(true));
    root.querySelector("#routineNew")?.addEventListener("click", openCreate);
    root.querySelector("#routineEmptyNew")?.addEventListener("click", openCreate);
    root.querySelectorAll("[data-routine-action]").forEach((button) => button.addEventListener("click", () => runAction(button)));
    root.querySelectorAll("[data-routine-delete]").forEach((button) => button.addEventListener("click", () => confirmDialog({
      title: "Delete routine",
      message: `Delete ${button.dataset.name}? Its previous run history remains in Hermes sessions.`,
      confirmText: "Delete",
      onConfirm: async () => {
        try { await api.routines.remove(button.dataset.routineDelete, button.dataset.profile); toast("success", "Routine deleted"); await load(true); }
        catch (actionError) { toast("error", "Could not delete routine", actionError.message); }
      },
    })));
    root.querySelectorAll("[data-routine-runs]").forEach((button) => button.addEventListener("click", () => openRuns(button.dataset.routineRuns, button.dataset.profile)));
    if (!state && !loading) load();
  },
};

async function load(force = false) {
  if (loading && !force) return;
  loading = true;
  try {
    const [jobs, targets, profiles, skills] = await Promise.all([
      api.routines.list("all"),
      api.routines.deliveryTargets(),
      api.kanban.profiles().catch(() => ({ profiles: [] })),
      api.skills.list("default").catch(() => []),
    ]);
    state = {
      jobs: Array.isArray(jobs) ? jobs : [],
      targets: targets.targets || [],
      profiles: profiles.profiles || [],
      skills: Array.isArray(skills) ? skills : [],
    };
    error = "";
  } catch (loadError) { error = loadError.message || "Hermes Cron is unavailable"; }
  loading = false;
  rerender();
}

async function runAction(button) {
  const action = button.dataset.routineAction;
  button.classList.add("loading");
  try {
    await api.routines.action(button.dataset.id, action, button.dataset.profile);
    toast("success", action === "trigger" ? "Routine queued" : `Routine ${action}d`, action === "trigger" ? "Hermes will run it in a fresh audited session." : "");
    setTimeout(() => load(true), action === "trigger" ? 1500 : 0);
  } catch (actionError) {
    toast("error", `Could not ${action} routine`, actionError.message);
    button.classList.remove("loading");
  }
}

function openCreate() {
  const profiles = state?.profiles?.length ? state.profiles : [{ name: "default", display_name: "Orchestrator" }];
  const targets = state?.targets?.length ? state.targets : [{ id: "local", name: "Local (save only)", home_target_set: true }];
  const skills = (state?.skills || []).filter((skill) => skill.enabled).slice(0, 120);
  openModal({
    title: "Create routine",
    width: 760,
    body: `
      <div class="routine-presets mb-4">
        <button class="btn btn-secondary sm" data-preset="ops">Daily operations brief</button>
        <button class="btn btn-secondary sm" data-preset="memory">Weekly memory review</button>
        <button class="btn btn-secondary sm" data-preset="content">Weekday content pipeline</button>
      </div>
      <div class="grid cols-2">
        <label class="field"><span class="label">Name</span><input class="input" id="routineName" placeholder="Daily operations brief"/></label>
        <label class="field"><span class="label">Agent profile</span><select class="select" id="routineProfile">${profiles.map((item) => `<option value="${esc(item.name)}">${esc(item.display_name || item.name)}</option>`).join("")}</select></label>
        <label class="field"><span class="label">Schedule</span><input class="input mono" id="routineSchedule" placeholder="0 9 * * *"/><span class="hint">Cron expression or “every 2h”</span></label>
        <label class="field"><span class="label">Delivery</span><select class="select" id="routineDeliver">${targets.map((item) => `<option value="${esc(item.id)}" ${item.home_target_set === false ? "disabled" : ""}>${esc(item.name || item.id)}${item.home_target_set === false ? " · configure channel" : ""}</option>`).join("")}</select></label>
      </div>
      <label class="field mt-3"><span class="label">Task prompt</span><textarea class="textarea" id="routinePrompt" placeholder="Describe a self-contained task with expected output and verification."></textarea></label>
      <label class="field mt-3"><span class="label">Skills (up to 5)</span><select class="select routine-skills" id="routineSkills" multiple size="6">${skills.map((skill) => `<option value="${esc(skill.name)}">${esc(skill.name)} · ${esc(skill.category || "general")}</option>`).join("")}</select><span class="hint">Hold Ctrl/Cmd to select several reusable procedures.</span></label>`,
    footer: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="routineCreate">${icon("calendar")}Schedule routine</button>`,
    onMount: (modal) => {
      const presets = {
        ops: { name: "Daily operations brief", schedule: "0 9 * * *", prompt: "Review Agentic OS health, active incidents, blocked Kanban work and pending approvals. Produce a concise operational brief with verified facts and the three highest-priority actions. Do not change external systems.", skill: "agentic-os-integration" },
        memory: { name: "Weekly memory review", schedule: "0 9 * * 1", prompt: "Review the shared Obsidian workspace context and this week's completed work. Summarize durable decisions, unresolved risks and knowledge that should be improved. Save the report locally and do not modify source notes without approval.", skill: "summarize" },
        content: { name: "Weekday content pipeline", schedule: "0 10 * * 1-5", prompt: "Review the content backlog, identify the highest-value ready item and prepare a concise draft with sources. Leave publication behind a human approval gate.", skill: "agentic-os-integration" },
      };
      modal.querySelectorAll("[data-preset]").forEach((button) => button.onclick = () => {
        const preset = presets[button.dataset.preset];
        modal.querySelector("#routineName").value = preset.name;
        modal.querySelector("#routineSchedule").value = preset.schedule;
        modal.querySelector("#routinePrompt").value = preset.prompt;
        [...modal.querySelector("#routineSkills").options].forEach((option) => { option.selected = option.value === preset.skill; });
      });
      modal.querySelector("#routineCreate").onclick = async (event) => {
        const button = event.currentTarget;
        button.classList.add("loading");
        const selectedSkills = [...modal.querySelector("#routineSkills").selectedOptions].map((option) => option.value);
        try {
          await api.routines.create({
            name: modal.querySelector("#routineName").value,
            profile: modal.querySelector("#routineProfile").value,
            schedule: modal.querySelector("#routineSchedule").value,
            deliver: modal.querySelector("#routineDeliver").value,
            prompt: modal.querySelector("#routinePrompt").value,
            skills: selectedSkills,
          });
          closeOverlay();
          toast("success", "Routine scheduled", "Run it once manually to verify the output before relying on the schedule.");
          await load(true);
        } catch (createError) { toast("error", "Could not create routine", createError.message); button.classList.remove("loading"); }
      };
    },
  });
}

async function openRuns(id, profile) {
  openModal({ title: "Run history", width: 700, body: loadingCard("Reading immutable Hermes run records…") });
  try {
    const result = await api.routines.runs(id, profile);
    const runs = result.runs || [];
    openModal({
      title: "Run history",
      width: 700,
      body: runs.length ? `<div class="stack gap-2">${runs.map((run) => `<div class="routine-run"><div><div class="fw-600">${esc(run.title || run.id || "Hermes run")}</div><div class="hint mt-1">${esc(dateValue(run.started_at))}${run.ended_at ? ` · ended ${esc(dateValue(run.ended_at))}` : " · running"}</div></div><span class="badge ${run.ended_at && !run.error ? "success" : run.error ? "error" : "warning"}">${run.error ? "failed" : run.ended_at ? "completed" : "running"}</span></div>`).join("")}</div>` : `<div class="empty"><div class="empty-ico">${icon("activity")}</div><h4>No runs yet</h4><p>Use Run now once to verify the routine before its first scheduled execution.</p></div>`,
      footer: `<button class="btn btn-secondary" data-close>Close</button>`,
    });
  } catch (runsError) {
    openModal({ title: "Run history", width: 520, body: `<div class="alert error"><div class="a-body"><div class="a-title">Could not load runs</div><div class="a-desc">${esc(runsError.message)}</div></div></div>` });
  }
}

export default routines;
