import { api } from "../api.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { closeOverlay, confirmDialog, esc, openModal, toast } from "../ui.js";

const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
let state = null;
let error = "";
let loading = false;

function head(actions = "") {
  return `<div class="page-head"><div><div class="page-title">${t("routines.title")}</div><div class="page-sub">${t("routines.sub")}</div></div><div class="spacer"></div>${actions}</div>`;
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
  if (!value) return t("routines.notYet");
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
      <strong>${esc(job.name || t("routines.unnamed"))}</strong>
      <span class="routine-prompt">${esc(job.prompt || (job.no_agent ? t("routines.scriptOnly") : t("routines.skillBacked")))}</span>
    </button>
    <div class="routine-facts">
      <div><span>${t("routines.schedule")}</span><strong class="mono">${esc(job.schedule || t("routines.notSet"))}</strong></div>
      <div><span>${t("routines.delivery")}</span><strong>${esc(job.deliver || "local")}</strong></div>
      <div><span>${t("routines.nextRun")}</span><strong>${esc(dateValue(job.next_run_at || job.nextRunAt))}</strong></div>
    </div>
    ${(job.skills || []).length ? `<div class="row gap-2 wrap">${job.skills.map((skill) => `<span class="badge info">/${esc(skill)}</span>`).join("")}</div>` : ""}
    ${api.auth.canAdmin ? `<div class="routine-actions">
      <button class="icon-btn tip" data-routine-action="trigger" data-id="${esc(id)}" data-profile="${esc(profile)}" data-tip="${t("routines.runNow")}">${icon("play")}</button>
      <button class="icon-btn tip" data-routine-action="${current === "paused" ? "resume" : "pause"}" data-id="${esc(id)}" data-profile="${esc(profile)}" data-tip="${current === "paused" ? t("routines.resume") : t("routines.pause")}">${icon(current === "paused" ? "play" : "pause")}</button>
      <button class="icon-btn tip" data-routine-delete="${esc(id)}" data-profile="${esc(profile)}" data-name="${esc(job.name || t("routines.one"))}" data-tip="${t("routines.delete")}">${icon("trash")}</button>
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
      ${mini(t("routines.total"), jobs.length, "calendar")}
      ${mini(t("routines.active"), active, "check")}
      ${mini(t("routines.pausedCount"), paused, "pause")}
      ${mini(t("routines.needsAttention"), failed, "warn")}
    </div>
    ${jobs.length ? `<div class="grid cols-3">${jobs.map(card).join("")}</div>` : `<div class="empty routine-empty"><div class="empty-ico">${icon("calendar")}</div><h4>${t("routines.emptyTitle")}</h4><p>${t("routines.emptyHint")}</p>${api.auth.canAdmin ? `<button class="btn btn-primary mt-3" id="routineEmptyNew">${icon("plus")}${t("routines.createFirst")}</button>` : ""}</div>`}`;
}

function mini(label, value, ico) {
  return `<div class="stat"><div class="row between"><span class="stat-label">${esc(label)}</span><div class="stat-icon">${icon(ico)}</div></div><div class="stat-value">${esc(value)}</div></div>`;
}

const routines = {
  title: "Routines",
  render() {
    const actions = api.on ? `<button class="btn btn-secondary" id="routineRefresh">${icon("refresh")}Refresh</button>${api.auth.canAdmin ? `<button class="btn btn-primary" id="routineNew">${icon("plus")}New routine</button>` : ""}` : "";
    if (!api.on) return head(actions) + `<div class="alert warning"><div class="a-body"><div class="a-title">${t("routines.backendRequired")}</div><div class="a-desc">${t("routines.backendHint")}</div></div></div>`;
    if (error) return head(actions) + `<div class="alert error"><div class="a-body"><div class="a-title">${t("routines.unavailable")}</div><div class="a-desc">${esc(error)}</div></div></div>`;
    return head(actions) + (state ? bodyHTML() : loadingCard(t("routines.loading")));
  },
  mount(root) {
    if (!api.on) return;
    root.querySelector("#routineRefresh")?.addEventListener("click", () => load(true));
    root.querySelector("#routineNew")?.addEventListener("click", openCreate);
    root.querySelector("#routineEmptyNew")?.addEventListener("click", openCreate);
    root.querySelectorAll("[data-routine-action]").forEach((button) => button.addEventListener("click", () => runAction(button)));
    root.querySelectorAll("[data-routine-delete]").forEach((button) => button.addEventListener("click", () => confirmDialog({
      title: t("routines.deleteTitle"),
      message: `Delete ${button.dataset.name}? Its previous run history remains in Hermes sessions.`,
      confirmText: t("routines.delete"),
      onConfirm: async () => {
        try { await api.routines.remove(button.dataset.routineDelete, button.dataset.profile); toast("success", t("routines.deleted")); await load(true); }
        catch (actionError) { toast("error", t("routines.deleteFailed"), actionError.message); }
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
  } catch (loadError) { error = loadError.message || t("routines.cronUnavailable"); }
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
  const profiles = state?.profiles?.length ? state.profiles : [{ name: "default", display_name: t("routines.orchestrator") }];
  const targets = state?.targets?.length ? state.targets : [{ id: "local", name: t("routines.localOnly"), home_target_set: true }];
  const skills = (state?.skills || []).filter((skill) => skill.enabled).slice(0, 120);
  openModal({
    title: t("routines.createTitle"),
    width: 760,
    body: `
      <div class="routine-presets mb-4">
        <button class="btn btn-secondary sm" data-preset="ops">${t("routines.preset.ops")}</button>
        <button class="btn btn-secondary sm" data-preset="memory">${t("routines.preset.memory")}</button>
        <button class="btn btn-secondary sm" data-preset="content">${t("routines.preset.content")}</button>
      </div>
      <div class="grid cols-2">
        <label class="field"><span class="label">${t("routines.field.name")}</span><input class="input" id="routineName" placeholder="${t("routines.preset.ops")}"/></label>
        <label class="field"><span class="label">${t("routines.field.profile")}</span><select class="select" id="routineProfile">${profiles.map((item) => `<option value="${esc(item.name)}">${esc(item.display_name || item.name)}</option>`).join("")}</select></label>
        <label class="field"><span class="label">${t("routines.schedule")}</span><input class="input mono" id="routineSchedule" placeholder="0 9 * * *"/><span class="hint">${t("routines.field.scheduleHint")}</span></label>
        <label class="field"><span class="label">${t("routines.delivery")}</span><select class="select" id="routineDeliver">${targets.map((item) => `<option value="${esc(item.id)}" ${item.home_target_set === false ? "disabled" : ""}>${esc(item.name || item.id)}${item.home_target_set === false ? ` · ${t("routines.configureChannel")}` : ""}</option>`).join("")}</select></label>
      </div>
      <label class="field mt-3"><span class="label">${t("routines.field.prompt")}</span><textarea class="textarea" id="routinePrompt" placeholder="${t("routines.field.promptHint")}"></textarea></label>
      <label class="field mt-3"><span class="label">${t("routines.field.skills")}</span><select class="select routine-skills" id="routineSkills" multiple size="6">${skills.map((skill) => `<option value="${esc(skill.name)}">${esc(skill.name)} · ${esc(skill.category || "general")}</option>`).join("")}</select><span class="hint">${t("routines.field.skillsHint")}</span></label>`,
    footer: `<button class="btn btn-secondary" data-close>${t("routines.cancel")}</button><button class="btn btn-primary" id="routineCreate">${icon("calendar")}${t("routines.scheduleIt")}</button>`,
    onMount: (modal) => {
      const presets = {
        ops: { name: t("routines.preset.ops"), schedule: "0 9 * * *", prompt: "Review Agentic OS health, active incidents, blocked Kanban work and pending approvals. Produce a concise operational brief with verified facts and the three highest-priority actions. Do not change external systems.", skill: "agentic-os-integration" },
        memory: { name: t("routines.preset.memory"), schedule: "0 9 * * 1", prompt: "Review the shared Obsidian workspace context and this week's completed work. Summarize durable decisions, unresolved risks and knowledge that should be improved. Save the report locally and do not modify source notes without approval.", skill: "summarize" },
        content: { name: t("routines.preset.content"), schedule: "0 10 * * 1-5", prompt: "Review the content backlog, identify the highest-value ready item and prepare a concise draft with sources. Leave publication behind a human approval gate.", skill: "agentic-os-integration" },
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
          toast("success", t("routines.scheduled"), t("routines.scheduledHint"));
          await load(true);
        } catch (createError) { toast("error", t("routines.createFailed"), createError.message); button.classList.remove("loading"); }
      };
    },
  });
}

async function openRuns(id, profile) {
  openModal({ title: t("routines.history"), width: 700, body: loadingCard(t("routines.historyLoading")) });
  try {
    const result = await api.routines.runs(id, profile);
    const runs = result.runs || [];
    openModal({
      title: t("routines.history"),
      width: 700,
      body: runs.length ? `<div class="stack gap-2">${runs.map((run) => `<div class="routine-run"><div><div class="fw-600">${esc(run.title || run.id || t("routines.run"))}</div><div class="hint mt-1">${esc(dateValue(run.started_at))}${run.ended_at ? ` · ${t("routines.ended", { when: dateValue(run.ended_at) })}` : ` · ${t("routines.running")}`}</div></div><span class="badge ${run.ended_at && !run.error ? "success" : run.error ? "error" : "warning"}">${run.error ? t("routines.failed") : run.ended_at ? t("routines.completed") : t("routines.running")}</span></div>`).join("")}</div>` : `<div class="empty"><div class="empty-ico">${icon("activity")}</div><h4>${t("routines.noRuns")}</h4><p>${t("routines.noRunsHint")}</p></div>`,
      footer: `<button class="btn btn-secondary" data-close>${t("routines.close")}</button>`,
    });
  } catch (runsError) {
    openModal({ title: "Run history", width: 520, body: `<div class="alert error"><div class="a-body"><div class="a-title">${t("routines.historyFailed")}</div><div class="a-desc">${esc(runsError.message)}</div></div></div>` });
  }
}

export default routines;
