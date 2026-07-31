import { api } from "../api.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { confirmDialog, esc, openModal, toast } from "../ui.js";

let snapshot = null;
let root = null;

const money = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value) || 0);
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(new Date(value)) : "—";
const values = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
const status = (kind, value) => `<span class="studio-status ${esc(value)}">${t(`studio.${kind}.status.${value}`)}</span>`;
const collectionStatuses = ["planning", "research", "design", "sampling", "approved", "production", "released", "archived"];
const modelStatuses = ["idea", "research", "sketch", "technical", "sample", "review", "approved", "production", "released", "rejected"];
const campaignStatuses = ["brief", "concept", "production", "review", "scheduled", "live", "measuring", "complete", "cancelled"];
const statusOptions = (kind, items, selected) => items.map((value) =>
  `<option value="${value}"${value === selected ? " selected" : ""}>${t(`studio.${kind}.status.${value}`)}</option>`).join("");

function shell(titleKey, subtitleKey, actions, content) {
  return `<div class="page studio-page">
    <div class="page-head studio-head"><div><h1>${t(titleKey)}</h1><p>${t(subtitleKey)}</p></div><div class="row gap-2">${actions}</div></div>
    <div id="studioNotice" class="alert error hidden"><div class="a-body"><div class="a-title">${t("studio.loadError")}</div><div class="a-text"></div></div></div>
    ${content}
  </div>`;
}

function empty(iconName, title, text, action = "") {
  return `<div class="studio-empty"><span>${icon(iconName)}</span><h3>${title}</h3><p>${text}</p>${action}</div>`;
}

function metric(label, value, hint = "") {
  return `<div class="studio-metric"><span>${label}</span><strong>${value}</strong>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

async function load() {
  snapshot = await api.studio.snapshot();
  return snapshot;
}

function errorBox(error) {
  const box = root?.querySelector("#studioNotice");
  if (!box) return;
  box.classList.remove("hidden");
  box.querySelector(".a-text").textContent = error.message;
}

function collectionOptions(selected = "") {
  return `<option value="">${t("studio.design.noCollection")}</option>${snapshot.collections
    .map((item) => `<option value="${esc(item.id)}"${item.id === selected ? " selected" : ""}>${esc(item.name)}</option>`).join("")}`;
}

function modelOptions(selected = []) {
  return snapshot.models.map((item) =>
    `<label class="check-row"><input type="checkbox" value="${esc(item.id)}"${selected.includes(item.id) ? " checked" : ""}/><span>${esc(item.name)}</span><small>${esc(item.sku || item.category || "")}</small></label>`).join("");
}

function collectionModal(item = null) {
  openModal({
    title: t(item ? "studio.design.editCollection" : "studio.design.newCollection"),
    width: 680,
    body: `<div class="studio-form-grid">
      <label class="field span-2"><span class="label">${t("studio.name")}</span><input class="input" id="stName" value="${esc(item?.name || "")}" maxlength="160"/></label>
      <label class="field"><span class="label">${t("studio.design.season")}</span><input class="input" id="stSeason" value="${esc(item?.season || "")}"/></label>
      <label class="field"><span class="label">${t("studio.design.market")}</span><input class="input" id="stMarket" value="${esc(item?.market || "")}"/></label>
      <label class="field"><span class="label">${t("studio.design.audience")}</span><input class="input" id="stAudience" value="${esc(item?.audience || "")}"/></label>
      <label class="field"><span class="label">${t("studio.owner")}</span><input class="input" id="stOwner" value="${esc(item?.owner || "")}"/></label>
      <label class="field"><span class="label">${t("studio.status")}</span><select class="select" id="stStatus">${statusOptions("collection", collectionStatuses, item?.status || "planning")}</select></label>
      <label class="field span-2"><span class="label">${t("studio.design.theme")}</span><textarea class="textarea" id="stTheme" rows="4">${esc(item?.theme || "")}</textarea></label>
    </div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="stSave">${icon("save")}${t("system.save")}</button>`,
    onMount(modal) {
      modal.querySelector("#stSave").onclick = async () => {
        try {
          const body = {
            name: modal.querySelector("#stName").value,
            season: modal.querySelector("#stSeason").value,
            market: modal.querySelector("#stMarket").value,
            audience: modal.querySelector("#stAudience").value,
            owner: modal.querySelector("#stOwner").value,
            theme: modal.querySelector("#stTheme").value,
            status: modal.querySelector("#stStatus").value,
          };
          if (item) await api.studio.update("collections", item.id, body);
          else await api.studio.create("collections", body);
          modal.remove();
          await refreshDesign();
        } catch (error) { toast("error", t("studio.saveError"), error.message); }
      };
    },
  });
}

function modelModal(item = null) {
  openModal({
    title: t(item ? "studio.design.editModel" : "studio.design.newModel"),
    width: 760,
    body: `<div class="studio-form-grid">
      <label class="field span-2"><span class="label">${t("studio.name")}</span><input class="input" id="stName" value="${esc(item?.name || "")}"/></label>
      <label class="field"><span class="label">${t("studio.design.collection")}</span><select class="select" id="stCollection">${collectionOptions(item?.collectionId)}</select></label>
      <label class="field"><span class="label">${t("studio.design.sku")}</span><input class="input" id="stSku" value="${esc(item?.sku || "")}"/></label>
      <label class="field"><span class="label">${t("studio.design.category")}</span><input class="input" id="stCategory" value="${esc(item?.category || "")}"/></label>
      <label class="field"><span class="label">${t("studio.owner")}</span><input class="input" id="stOwner" value="${esc(item?.owner || "")}"/></label>
      <label class="field"><span class="label">${t("studio.status")}</span><select class="select" id="stStatus">${statusOptions("model", modelStatuses, item?.status || "idea")}</select></label>
      <label class="field"><span class="label">${t("studio.design.colors")}</span><input class="input" id="stColors" value="${esc((item?.colors || []).join(", "))}"/></label>
      <label class="field"><span class="label">${t("studio.design.materials")}</span><input class="input" id="stMaterials" value="${esc((item?.materials || []).join(", "))}"/></label>
      <label class="field"><span class="label">${t("studio.design.cost")}</span><input class="input" type="number" id="stCost" value="${item?.cost || 0}"/></label>
      <label class="field"><span class="label">${t("studio.design.price")}</span><input class="input" type="number" id="stPrice" value="${item?.price || 0}"/></label>
      <label class="field"><span class="label">${t("studio.design.forecast")}</span><input class="input" type="number" min="0" max="100" id="stForecast" value="${item?.forecastScore || 0}"/></label>
      <label class="field"><span class="label">${t("studio.design.units")}</span><input class="input" type="number" min="0" id="stUnits" value="${item?.targetUnits || 0}"/></label>
      <label class="field span-2"><span class="label">${t("studio.notes")}</span><textarea class="textarea" id="stNotes" rows="4">${esc(item?.notes || "")}</textarea></label>
    </div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="stSave">${icon("save")}${t("system.save")}</button>`,
    onMount(modal) {
      modal.querySelector("#stSave").onclick = async () => {
        try {
          const body = {
            name: modal.querySelector("#stName").value,
            collectionId: modal.querySelector("#stCollection").value,
            sku: modal.querySelector("#stSku").value,
            category: modal.querySelector("#stCategory").value,
            owner: modal.querySelector("#stOwner").value,
            colors: values(modal.querySelector("#stColors").value),
            materials: values(modal.querySelector("#stMaterials").value),
            cost: modal.querySelector("#stCost").value,
            price: modal.querySelector("#stPrice").value,
            forecastScore: modal.querySelector("#stForecast").value,
            targetUnits: modal.querySelector("#stUnits").value,
            notes: modal.querySelector("#stNotes").value,
            status: modal.querySelector("#stStatus").value,
          };
          if (item) await api.studio.update("models", item.id, body);
          else await api.studio.create("models", body);
          modal.remove();
          await refreshDesign();
        } catch (error) { toast("error", t("studio.saveError"), error.message); }
      };
    },
  });
}

function designContent() {
  const collections = snapshot.collections.map((item) => {
    const count = snapshot.models.filter((model) => model.collectionId === item.id).length;
    return `<article class="studio-collection" data-collection="${esc(item.id)}">
      <div><span class="studio-kicker">${esc(item.season || t("studio.design.noSeason"))}</span><h3>${esc(item.name)}</h3><p>${esc(item.theme || t("studio.design.noTheme"))}</p></div>
      <div class="studio-card-foot">${status("collection", item.status)}<span>${t("studio.design.modelCount", { count })}</span><button class="icon-btn" data-edit-collection="${esc(item.id)}">${icon("edit")}</button></div>
    </article>`;
  }).join("");
  const models = snapshot.models.map((item) => {
    const collection = snapshot.collections.find((entry) => entry.id === item.collectionId);
    return `<article class="studio-model" data-model="${esc(item.id)}">
      <div class="studio-model-media">${item.assets?.[0]?.url ? `<img src="${esc(item.assets[0].url)}" alt=""/>` : `<span>${icon("image")}</span><small>${t("studio.design.awaitingVisual")}</small>`}</div>
      <div class="studio-model-body"><div class="row between"><span class="studio-kicker">${esc(item.sku || item.category || t("studio.design.concept"))}</span>${status("model", item.status)}</div>
      <h3>${esc(item.name)}</h3><p>${esc(collection?.name || t("studio.design.noCollection"))}</p>
      <div class="studio-specs"><span>${t("studio.design.priceShort")} ${money(item.price)}</span><span>${t("studio.design.forecastShort")} ${item.forecastScore}%</span><span>${item.targetUnits || 0} ${t("studio.design.unitsShort")}</span></div>
      <div class="studio-card-foot"><button class="btn btn-secondary sm" data-edit-model="${esc(item.id)}">${icon("edit")}${t("system.edit")}</button><a class="btn btn-ghost sm" href="#/media">${icon("sparkles")}${t("studio.design.createMedia")}</a></div></div>
    </article>`;
  }).join("");
  return `<div class="studio-metrics">${metric(t("studio.design.collections"), snapshot.collections.length)}${metric(t("studio.design.models"), snapshot.models.length)}${metric(t("studio.design.approved"), snapshot.models.filter((item) => ["approved","production","released"].includes(item.status)).length)}${metric(t("studio.design.avgForecast"), `${snapshot.analytics.avgForecast}%`)}</div>
    <section class="studio-band"><header><div><h2>${t("studio.design.collections")}</h2><p>${t("studio.design.collectionsHint")}</p></div></header>
      <div class="studio-collection-grid">${collections || empty("layers", t("studio.design.emptyCollections"), t("studio.design.emptyCollectionsText"), `<button class="btn btn-primary sm" id="emptyCollection">${icon("plus")}${t("studio.design.newCollection")}</button>`)}</div>
    </section>
    <section class="studio-band"><header><div><h2>${t("studio.design.models")}</h2><p>${t("studio.design.modelsHint")}</p></div></header>
      <div class="studio-model-grid">${models || empty("image", t("studio.design.emptyModels"), t("studio.design.emptyModelsText"), `<button class="btn btn-primary sm" id="emptyModel">${icon("plus")}${t("studio.design.newModel")}</button>`)}</div>
    </section>`;
}

function wireDesign() {
  root.querySelector("#newCollection").onclick = () => collectionModal();
  root.querySelector("#newModel").onclick = () => modelModal();
  root.querySelector("#emptyCollection")?.addEventListener("click", () => collectionModal());
  root.querySelector("#emptyModel")?.addEventListener("click", () => modelModal());
  root.querySelectorAll("[data-edit-collection]").forEach((button) => button.onclick = () =>
    collectionModal(snapshot.collections.find((item) => item.id === button.dataset.editCollection)));
  root.querySelectorAll("[data-edit-model]").forEach((button) => button.onclick = () =>
    modelModal(snapshot.models.find((item) => item.id === button.dataset.editModel)));
}

async function refreshDesign() {
  await load();
  root.innerHTML = shell("studio.design.title", "studio.design.subtitle",
    `<button class="btn btn-secondary" id="newCollection">${icon("layers")}${t("studio.design.newCollection")}</button><button class="btn btn-primary" id="newModel">${icon("plus")}${t("studio.design.newModel")}</button>`,
    designContent());
  wireDesign();
}

function campaignModal(item = null) {
  openModal({
    title: t(item ? "studio.media.editCampaign" : "studio.media.newCampaign"),
    width: 760,
    body: `<div class="studio-form-grid">
      <label class="field span-2"><span class="label">${t("studio.name")}</span><input class="input" id="stName" value="${esc(item?.name || "")}"/></label>
      <label class="field"><span class="label">${t("studio.media.goal")}</span><input class="input" id="stGoal" value="${esc(item?.goal || "")}"/></label>
      <label class="field"><span class="label">${t("studio.owner")}</span><input class="input" id="stOwner" value="${esc(item?.owner || "")}"/></label>
      <label class="field"><span class="label">${t("studio.media.channels")}</span><input class="input" id="stChannels" value="${esc((item?.channels || []).join(", "))}" placeholder="Instagram, TikTok, Telegram"/></label>
      <label class="field"><span class="label">${t("studio.media.budget")}</span><input class="input" type="number" id="stBudget" value="${item?.budget || 0}"/></label>
      <label class="field"><span class="label">${t("studio.status")}</span><select class="select" id="stStatus">${statusOptions("campaign", campaignStatuses, item?.status || "brief")}</select></label>
      <label class="field"><span class="label">${t("studio.media.start")}</span><input class="input" type="date" id="stStart" value="${esc(item?.startAt || "")}"/></label>
      <label class="field"><span class="label">${t("studio.media.end")}</span><input class="input" type="date" id="stEnd" value="${esc(item?.endAt || "")}"/></label>
      <div class="field span-2"><span class="label">${t("studio.media.models")}</span><div class="studio-check-list">${modelOptions(item?.modelIds || []) || `<span class="muted">${t("studio.design.emptyModels")}</span>`}</div></div>
      <label class="field span-2"><span class="label">${t("studio.media.brief")}</span><textarea class="textarea" id="stBrief" rows="5">${esc(item?.brief || "")}</textarea></label>
    </div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="stSave">${icon("save")}${t("system.save")}</button>`,
    onMount(modal) {
      modal.querySelector("#stSave").onclick = async () => {
        try {
          const body = {
            name: modal.querySelector("#stName").value,
            goal: modal.querySelector("#stGoal").value,
            owner: modal.querySelector("#stOwner").value,
            channels: values(modal.querySelector("#stChannels").value),
            budget: modal.querySelector("#stBudget").value,
            modelIds: [...modal.querySelectorAll(".studio-check-list input:checked")].map((input) => input.value),
            brief: modal.querySelector("#stBrief").value,
            status: modal.querySelector("#stStatus").value,
            startAt: modal.querySelector("#stStart").value,
            endAt: modal.querySelector("#stEnd").value,
          };
          if (item) await api.studio.update("campaigns", item.id, body);
          else await api.studio.create("campaigns", body);
          modal.remove();
          await refreshMedia();
        } catch (error) { toast("error", t("studio.saveError"), error.message); }
      };
    },
  });
}

function generationModal() {
  openModal({
    title: t("studio.media.newGeneration"),
    width: 700,
    body: `<div class="studio-form-grid">
      <label class="field"><span class="label">${t("studio.media.assetType")}</span><select class="select" id="stType"><option value="image">${t("studio.media.image")}</option><option value="video">${t("studio.media.video")}</option></select></label>
      <label class="field"><span class="label">${t("studio.media.aspect")}</span><select class="select" id="stAspect"><option>4:5</option><option>1:1</option><option>9:16</option><option>16:9</option></select></label>
      <label class="field"><span class="label">${t("studio.media.model")}</span><select class="select" id="stModel"><option value="">—</option>${snapshot.models.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}</select></label>
      <label class="field"><span class="label">${t("studio.media.campaign")}</span><select class="select" id="stCampaign"><option value="">—</option>${snapshot.campaigns.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}</select></label>
      <label class="field span-2"><span class="label">${t("studio.media.generationBrief")}</span><textarea class="textarea" id="stBrief" rows="7" placeholder="${t("studio.media.generationPlaceholder")}"></textarea></label>
      <div class="studio-provider span-2">${icon("sparkles")}<div><strong>Higgsfield MCP</strong><span>${t("studio.media.higgsfieldRoute")}</span></div></div>
    </div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="stSave">${icon("send")}${t("studio.media.queueHermes")}</button>`,
    onMount(modal) {
      modal.querySelector("#stSave").onclick = async () => {
        try {
          const created = await api.studio.create("generations", {
            type: modal.querySelector("#stType").value,
            aspectRatio: modal.querySelector("#stAspect").value,
            modelId: modal.querySelector("#stModel").value,
            campaignId: modal.querySelector("#stCampaign").value,
            brief: modal.querySelector("#stBrief").value,
          });
          await api.studio.queueGeneration(created.id);
          modal.remove();
          toast("success", t("studio.media.queued"), t("studio.media.queuedText"));
          await refreshMedia();
        } catch (error) { toast("error", t("studio.media.queueFailed"), error.message); }
      };
    },
  });
}

function mediaContent() {
  const campaigns = snapshot.campaigns.map((item) => `<article class="studio-campaign">
    <div class="row between"><span class="studio-kicker">${esc((item.channels || []).join(" · ") || t("studio.media.noChannels"))}</span>${status("campaign", item.status)}</div>
    <h3>${esc(item.name)}</h3><p>${esc(item.goal || item.brief || t("studio.media.noBrief"))}</p>
    <div class="studio-campaign-metrics"><span><b>${money(item.budget)}</b>${t("studio.media.budget")}</span><span><b>${item.modelIds.length}</b>${t("studio.media.models")}</span><span><b>${item.metrics?.conversions || 0}</b>${t("studio.media.conversions")}</span></div>
    <div class="studio-card-foot"><span>${date(item.startAt)} – ${date(item.endAt)}</span><button class="btn btn-secondary sm" data-edit-campaign="${esc(item.id)}">${icon("edit")}${t("system.edit")}</button></div>
  </article>`).join("");
  const jobs = snapshot.generationJobs.map((item) => `<article class="studio-job">
    <span class="studio-job-icon">${icon(item.type === "video" ? "video" : "image")}</span>
    <div><div class="row gap-2">${status("job", item.status)}<code>${esc(item.aspectRatio)}</code></div><h3>${esc(item.brief)}</h3>
    <p>Higgsfield MCP · Hermes${item.kanbanTaskId ? ` · ${esc(item.kanbanTaskId)}` : ""}</p></div>
    <div class="row gap-1"><button class="icon-btn tip" data-sync-job="${esc(item.id)}" data-tip="${t("studio.media.sync")}">${icon("refresh")}</button>
    ${item.outputUrl ? `<a class="icon-btn" href="${esc(item.outputUrl)}" target="_blank" rel="noopener">${icon("external")}</a>` : `<a class="icon-btn" href="#/kanban">${icon("arrowright")}</a>`}</div>
  </article>`).join("");
  return `<div class="studio-metrics">${metric(t("studio.media.campaigns"), snapshot.campaigns.length)}${metric(t("studio.media.live"), snapshot.analytics.liveCampaigns)}${metric(t("studio.media.jobs"), snapshot.generationJobs.length)}${metric(t("studio.media.channels"), new Set(snapshot.campaigns.flatMap((item) => item.channels)).size)}</div>
    <section class="studio-band"><header><div><h2>${t("studio.media.campaigns")}</h2><p>${t("studio.media.campaignsHint")}</p></div></header>
      <div class="studio-campaign-grid">${campaigns || empty("calendar", t("studio.media.emptyCampaigns"), t("studio.media.emptyCampaignsText"), `<button class="btn btn-primary sm" id="emptyCampaign">${icon("plus")}${t("studio.media.newCampaign")}</button>`)}</div>
    </section>
    <section class="studio-band"><header><div><h2>${t("studio.media.productionQueue")}</h2><p>${t("studio.media.productionHint")}</p></div><a class="btn btn-ghost sm" href="#/kanban">${t("studio.openKanban")}${icon("arrowright")}</a></header>
      <div class="studio-job-list">${jobs || empty("sparkles", t("studio.media.emptyJobs"), t("studio.media.emptyJobsText"))}</div>
    </section>`;
}

function wireMedia() {
  root.querySelector("#newCampaign").onclick = () => campaignModal();
  root.querySelector("#newGeneration").onclick = generationModal;
  root.querySelector("#emptyCampaign")?.addEventListener("click", () => campaignModal());
  root.querySelectorAll("[data-edit-campaign]").forEach((button) => button.onclick = () =>
    campaignModal(snapshot.campaigns.find((item) => item.id === button.dataset.editCampaign)));
  root.querySelectorAll("[data-sync-job]").forEach((button) => button.onclick = async () => {
    button.classList.add("loading");
    try {
      await api.studio.syncGeneration(button.dataset.syncJob);
      toast("success", t("studio.media.synced"), t("studio.media.syncedText"));
      await refreshMedia();
    } catch (error) { toast("error", t("studio.media.syncFailed"), error.message); }
    finally { button.classList.remove("loading"); }
  });
}

async function refreshMedia() {
  await load();
  root.innerHTML = shell("studio.media.title", "studio.media.subtitle",
    `<button class="btn btn-secondary" id="newCampaign">${icon("calendar")}${t("studio.media.newCampaign")}</button><button class="btn btn-primary" id="newGeneration">${icon("sparkles")}${t("studio.media.newGeneration")}</button>`,
    mediaContent());
  wireMedia();
}

function signalModal() {
  openModal({
    title: t("studio.analytics.newSignal"),
    width: 720,
    body: `<div class="studio-form-grid">
      <label class="field"><span class="label">${t("studio.analytics.type")}</span><select class="select" id="stType">${["trend","competitor","mass_market","sales","customer"].map((type) => `<option value="${type}">${t(`studio.analytics.type.${type}`)}</option>`).join("")}</select></label>
      <label class="field"><span class="label">${t("studio.design.category")}</span><input class="input" id="stCategory"/></label>
      <label class="field span-2"><span class="label">${t("studio.name")}</span><input class="input" id="stTitle"/></label>
      <label class="field"><span class="label">${t("studio.analytics.score")}</span><input class="input" id="stScore" type="number" min="-100" max="100" value="0"/></label>
      <label class="field"><span class="label">${t("studio.analytics.confidence")}</span><input class="input" id="stConfidence" type="number" min="0" max="100" value="50"/></label>
      <label class="field span-2"><span class="label">${t("studio.analytics.source")}</span><input class="input" id="stSource" placeholder="URL, ERP, marketplace, report"/></label>
      <label class="field span-2"><span class="label">${t("studio.analytics.summary")}</span><textarea class="textarea" id="stSummary" rows="5"></textarea></label>
      <div class="field span-2"><span class="label">${t("studio.analytics.relatedModels")}</span><div class="studio-check-list">${modelOptions([]) || `<span class="muted">${t("studio.design.emptyModels")}</span>`}</div></div>
    </div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" id="stSave">${icon("save")}${t("system.save")}</button>`,
    onMount(modal) {
      modal.querySelector("#stSave").onclick = async () => {
        try {
          await api.studio.create("signals", {
            type: modal.querySelector("#stType").value,
            title: modal.querySelector("#stTitle").value,
            category: modal.querySelector("#stCategory").value,
            score: modal.querySelector("#stScore").value,
            confidence: modal.querySelector("#stConfidence").value,
            source: modal.querySelector("#stSource").value,
            summary: modal.querySelector("#stSummary").value,
            modelIds: [...modal.querySelectorAll(".studio-check-list input:checked")].map((input) => input.value),
          });
          modal.remove();
          await refreshAnalytics();
        } catch (error) { toast("error", t("studio.saveError"), error.message); }
      };
    },
  });
}

function analyticsContent() {
  const types = ["trend", "competitor", "mass_market", "sales", "customer"];
  const streams = types.map((type) => {
    const items = snapshot.signals.filter((signal) => signal.type === type);
    return `<article class="studio-stream ${type}"><header><span>${icon(type === "trend" ? "sparkles" : type === "competitor" ? "eye" : type === "sales" ? "activity" : type === "customer" ? "agents" : "grid")}</span><div><h3>${t(`studio.analytics.type.${type}`)}</h3><p>${t(`studio.analytics.type.${type}.hint`)}</p></div><b>${items.length}</b></header>
      <div>${items.slice(0, 3).map((item) => `<button class="studio-signal" type="button"><span class="${item.score >= 0 ? "positive" : "negative"}">${item.score > 0 ? "+" : ""}${item.score}</span><div><strong>${esc(item.title)}</strong><small>${esc(item.source || item.category || t("studio.analytics.manual"))}</small></div><em>${item.confidence}%</em></button>`).join("") || `<p class="studio-stream-empty">${t("studio.analytics.noSignals")}</p>`}</div>
    </article>`;
  }).join("");
  const recommendations = snapshot.analytics.recommendations.map((item) => `<tr>
    <td><strong>${esc(item.modelName)}</strong><small>${item.evidenceCount} ${t("studio.analytics.evidence")}</small></td>
    <td><span class="studio-recommend ${esc(item.action)}">${t(`studio.analytics.action.${item.action}`)}</span></td>
    <td><b>${item.score > 0 ? "+" : ""}${item.score}</b></td><td>${item.confidence}%</td>
  </tr>`).join("");
  return `<div class="studio-metrics">${metric(t("studio.analytics.signals"), snapshot.signals.length)}${metric(t("studio.analytics.models"), snapshot.analytics.models)}${metric(t("studio.analytics.avgForecast"), `${snapshot.analytics.avgForecast}%`)}${metric(t("studio.analytics.liveCampaigns"), snapshot.analytics.liveCampaigns)}</div>
    <section class="studio-band"><header><div><h2>${t("studio.analytics.intelligence")}</h2><p>${t("studio.analytics.intelligenceHint")}</p></div></header><div class="studio-stream-grid">${streams}</div></section>
    <section class="studio-band"><header><div><h2>${t("studio.analytics.recommendations")}</h2><p>${t("studio.analytics.recommendationsHint")}</p></div></header>
      ${recommendations ? `<div class="table-wrap"><table class="data-table studio-table"><thead><tr><th>${t("studio.analytics.model")}</th><th>${t("studio.analytics.decision")}</th><th>${t("studio.analytics.score")}</th><th>${t("studio.analytics.confidence")}</th></tr></thead><tbody>${recommendations}</tbody></table></div>`
        : empty("activity", t("studio.analytics.emptyRecommendations"), t("studio.analytics.emptyRecommendationsText"))}
    </section>`;
}

async function refreshAnalytics() {
  await load();
  root.innerHTML = shell("studio.analytics.title", "studio.analytics.subtitle",
    `<a class="btn btn-secondary" href="#/design">${icon("image")}${t("studio.analytics.openDesign")}</a><button class="btn btn-primary" id="newSignal">${icon("plus")}${t("studio.analytics.newSignal")}</button>`,
    analyticsContent());
  root.querySelector("#newSignal").onclick = signalModal;
}

function page(refresh) {
  return {
    title: "",
    render() {
      return `<div class="page studio-page"><div class="skeleton" style="height:160px"></div></div>`;
    },
    mount(node) {
      root = node;
      refresh().catch((error) => {
        root.innerHTML = shell("studio.loadError", "studio.loadErrorText", "", "");
        errorBox(error);
      });
    },
  };
}

export const design = page(refreshDesign);
export const media = page(refreshMedia);
export const analytics = page(refreshAnalytics);
