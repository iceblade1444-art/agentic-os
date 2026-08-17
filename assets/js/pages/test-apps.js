import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { qs } from "../ui.js";

const text = () => ({
  title: t("testApps.title"), subtitle: t("testApps.subtitle"), badge: t("testApps.badge"), install: t("testApps.install"),
  health: t("testApps.health"), source: t("testApps.source"), online: t("testApps.online"), offline: t("testApps.offline"),
  checking: t("testApps.checking"), desc: t("testApps.desc"), agents: t("testApps.agents"), agentsText: t("testApps.agentsText"),
});

export default {
  title: "Test Apps",
  render() {
    const t = text();
    return `<div class="page-head"><div><div class="page-title">${t.title}</div><div class="page-sub">${t.subtitle}</div></div></div>
      <div class="grid cols-2">
        <section class="card pad-lg">
          <div class="card-head"><div>${icon("layers")}</div><div><h3>ATLAS Academy</h3><span class="badge warning"><span class="dot"></span>${t.badge}</span></div></div>
          <p>${t.desc}</p>
          <div class="stack" style="margin:16px 0"><span><strong>Android</strong> · v0.1.0</span><span class="cell-sub">Kotlin · Compose · FastAPI · PostgreSQL · Redis</span><span id="atlasHealth" class="badge neutral">${t.checking}</span></div>
          <div class="row wrap"><a class="btn btn-primary" href="/atlas-downloads/atlas-academy-0.1.0.apk" download>${icon("download")}${t.install}</a><button class="btn btn-secondary" id="atlasCheck">${icon("activity")}${t.health}</button></div>
        </section>
        <section class="card pad-lg"><div class="card-head"><div>${icon("code")}</div><h3>${t.source}</h3></div>
          <code>/app/work/atlas-academy</code><p class="page-sub" style="margin-top:12px">${t.agentsText}</p>
          <div class="stack" style="margin-top:16px"><strong>${t.agents}</strong><span>Product / Learning · Android · Backend · QA · Release</span><span class="cell-sub">Git · automated tests · build evidence · rollback APK</span></div>
        </section>
      </div>`;
  },
  mount(root) {
    const t = text(); const status = qs("#atlasHealth", root); const button = qs("#atlasCheck", root);
    const check = async () => {
      status.textContent = t.checking; status.className = "badge neutral";
      try {
        const response = await fetch("/atlas-api/health", { cache: "no-store" });
        if (!response.ok) throw new Error("health failed");
        status.textContent = t.online; status.className = "badge success";
      } catch {
        status.textContent = t.offline; status.className = "badge error";
      }
    };
    button?.addEventListener("click", check); check();
  },
};

