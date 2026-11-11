import { api } from "../api.js";
import { icon } from "../icons.js";
import { getLocale, t } from "../i18n.js";
import { esc, toast } from "../ui.js";

let value = null;
let loading = true;
let error = "";
const number = new Intl.NumberFormat();

const display = (metric, suffix = "") => metric === null || metric === undefined
  ? "—" : `${number.format(metric)}${suffix}`;
const dateTime = (input) => {
  if (input === null || input === undefined || input === "" || Number(input) === 0) {
    return t("production.unknown");
  }
  const date = new Date(input);
  return Number.isNaN(date.valueOf()) ? t("production.unknown")
    : new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date);
};

function metric(label, valueText, detail, tone = "") {
  return `<div class="production-kpi ${tone}"><span>${esc(label)}</span><strong>${esc(valueText)}</strong><small>${esc(detail)}</small></div>`;
}

function qualityBlock(quality = {}) {
  const complete = Number(quality.completenessPercent) || 0;
  const fresh = quality.freshnessMinutes;
  return `<section class="card production-quality" aria-labelledby="productionQualityTitle">
    <div><h3 id="productionQualityTitle">${t("production.dataQuality")}</h3><p>${t("production.qualityHint")}</p></div>
    <div class="production-quality-row">
      <div><span>${t("production.completeness")}</span><strong>${display(quality.completenessPercent, "%")}</strong>
        <progress max="100" value="${Math.min(100, complete)}">${complete}%</progress></div>
      <div><span>${t("production.freshness")}</span><strong>${fresh == null ? "—" : t("production.minutes", { count: fresh })}</strong>
        <small>${esc(dateTime(quality.sourceUpdatedAt))}</small></div>
    </div>
    ${(quality.missingData || []).length ? `<details><summary>${t("production.missing")}</summary><ul>${quality.missingData.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></details>` : ""}
  </section>`;
}

function findings(items = []) {
  if (!items.length) return `<div class="empty compact"><p>${t("production.noFindings")}</p></div>`;
  return `<div class="production-findings">${items.map((item) => `<article>
    <div class="production-finding-head"><strong>${esc(item.fact)}</strong><span class="badge ${item.confidence === "high" ? "success" : item.confidence === "medium" ? "warning" : "neutral"}">${t(`production.confidence.${item.confidence}`)}</span></div>
    <dl>
      <div><dt>${t("production.reason")}</dt><dd>${esc(item.assumedReason || t("production.reasonUnknown"))}</dd></div>
      <div><dt>${t("production.updated")}</dt><dd>${esc(dateTime(item.updatedAt))}</dd></div>
    </dl>
    ${(item.missingData || []).length ? `<p>${t("production.missingShort")}: ${esc(item.missingData.join(", "))}</p>` : ""}
  </article>`).join("")}</div>`;
}

function tasksTable(items = []) {
  if (!items.length) return `<div class="empty compact"><p>${t("production.noTasks")}</p></div>`;
  return `<div class="table-wrap"><table class="tbl"><thead><tr><th>${t("production.task")}</th><th>${t("production.status")}</th><th>${t("production.deadline")}</th></tr></thead><tbody>
    ${items.slice(0, 50).map((item) => `<tr><td><strong>${esc(item.title || item.name || item.task || "—")}</strong></td><td>${esc(item.status || item.state || "—")}</td><td>${esc(item.deadline || item.due_date || item.dueDate || "—")}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function page() {
  if (loading) return `<div class="page"><div class="page-head"><div><h1>${t("production.title")}</h1><p>${t("production.subtitle")}</p></div></div><div class="card">${t("production.loading")}</div></div>`;
  if (error || value?.ok === false) return `<div class="page"><div class="page-head"><div><h1>${t("production.title")}</h1><p>${t("production.subtitle")}</p></div></div><div class="alert warning"><div class="a-body"><div class="a-title">${t("production.unavailable")}</div><div class="a-text">${esc(error || value.message || t("production.unknown"))}</div></div></div></div>`;
  const m = value.metrics || {};
  const own = value.access === "own";
  return `<div class="page production-page">
    <div class="page-head"><div><h1>${t("production.title")}</h1><p>${t(own ? "production.ownSubtitle" : "production.subtitle")}</p></div><div class="spacer"></div>
      ${api.auth.canAdmin ? `<button class="btn btn-secondary" id="productionSync">${icon("refresh")}${t("production.sync")}</button>` : ""}
    </div>
    <div class="production-meta"><span class="badge neutral">${esc(value.scope?.name || "")}</span><span>${t("production.generated")}: ${esc(dateTime(value.generatedAt))}</span></div>
    ${own ? `<div class="grid cols-2 mb-4">${metric(t("production.myTasks"), display(m.taskCount), t("production.fromErp"), "")}</div>` : `
      <div class="production-kpis">
        ${metric(t("production.planFact"), display(m.planFactPercent, "%"), `${display(m.actual)} / ${display(m.planned)}`, m.planFactPercent >= 95 ? "ok" : m.planFactPercent == null ? "" : "risk")}
        ${metric(t("production.samEfficiency"), display(m.efficiencySamPercent, "%"), "SAM / available minutes", m.efficiencySamPercent >= 80 ? "ok" : "")}
        ${metric(t("production.fpy"), display(m.firstPassYieldPercent, "%"), t("production.firstPass"), m.firstPassYieldPercent >= 95 ? "ok" : "")}
        ${metric(t("production.otd"), display(m.onTimeDeliveryPercent, "%"), t("production.delivery"), m.onTimeDeliveryPercent >= 95 ? "ok" : "")}
        ${metric(t("production.downtime"), display(m.downtimeMinutes), t("production.minutesUnit"), m.downtimeMinutes ? "risk" : "")}
        ${metric(t("production.lateOrders"), display(m.lateOrders), t("production.orders"), m.lateOrders ? "risk" : "ok")}
      </div>
      ${qualityBlock(value.quality)}
      <section class="card"><div class="row gap-2 mb-3"><span class="aico">${icon("activity")}</span><div><h3>${t("production.findings")}</h3><p class="muted">${t("production.findingsHint")}</p></div></div>${findings(value.findings)}</section>`}
    <section class="card"><div class="row gap-2 mb-3"><span class="aico">${icon("workflow")}</span><div><h3>${t(own ? "production.myTasks" : "production.tasks")}</h3><p class="muted">${t(own ? "production.onlyOwn" : "production.tasksHint")}</p></div></div>${tasksTable(value.tasks)}</section>
  </div>`;
}

async function load(root) {
  loading = true; error = ""; root.innerHTML = page();
  try { value = await api.production.dashboard(); }
  catch (caught) { error = caught.message || String(caught); }
  loading = false; root.innerHTML = page();
  root.querySelector("#productionSync")?.addEventListener("click", async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { value = await api.production.sync(); root.innerHTML = page(); toast("success", t("production.synced"), t("production.syncedHint")); }
    catch (caught) { toast("error", t("production.unavailable"), caught.message); button.disabled = false; }
  });
}

export default { title: "Production Intelligence", render: page, mount: load };
