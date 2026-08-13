import { api } from "../api.js";
import { icon } from "../icons.js";
import { qs, toast } from "../ui.js";
import { t } from "../i18n.js";

function statusBadge(status) {
  if (!status) return `<span class="badge neutral"><span class="dot"></span>${t("hermes.checking")}</span>`;
  if (status.ready) return `<span class="badge success"><span class="dot"></span>${t("hermes.online")}</span>`;
  return `<span class="badge error"><span class="dot"></span>${t("hermes.offline")}</span>`;
}

export default {
  title: "Hermes Control",
  render: () => `
    <div class="hermes-control">
      <div class="page-head hermes-head">
        <div>
          <div class="page-title">${t("hermes.title")}</div>
          <div class="page-sub">${t("hermes.sub")}</div>
        </div>
        <div class="spacer"></div>
        <div id="hermesStatus">${statusBadge()}</div>
        <button class="icon-btn" id="hermesReload" title="${t("hermes.reload")}">${icon("refresh")}</button>
        <a class="btn btn-secondary" href="/hermes/" target="_blank" rel="noopener">${icon("external")}${t("hermes.fullscreen")}</a>
      </div>
      <div class="hermes-frame-shell">
        <div class="hermes-frame-loading" id="hermesLoading">
          <span class="spinner"></span><span>${t("hermes.connecting")}</span>
        </div>
        <iframe
          id="hermesFrame"
          class="hermes-frame"
          src="/hermes/"
          title="Hermes Agent Dashboard"
          allow="clipboard-read; clipboard-write; microphone"
        ></iframe>
      </div>
      <div class="alert error hidden" id="hermesError">
        <span class="a-ico">${icon("alert")}</span>
        <div class="a-body"><div class="a-title">${t("hermes.notResponding")}</div><div class="a-desc" id="hermesErrorText"></div></div>
      </div>
    </div>`,
  mount: async (root) => {
    const frame = qs("#hermesFrame", root);
    const loading = qs("#hermesLoading", root);
    const status = qs("#hermesStatus", root);
    const error = qs("#hermesError", root);
    const errorText = qs("#hermesErrorText", root);

    frame.addEventListener("load", () => loading?.classList.add("hidden"));
    qs("#hermesReload", root).onclick = async () => {
      loading?.classList.remove("hidden");
      frame.src = `/hermes/?reload=${Date.now()}`;
      try {
        const result = await api.hermes.status();
        status.innerHTML = statusBadge(result);
        toast(result.ready ? "success" : "error", result.ready ? t("hermes.online") : t("hermes.offline"));
      } catch (e) {
        status.innerHTML = statusBadge({ ready: false });
        toast("error", t("hermes.checkFailed"), e.message);
      }
    };

    try {
      const result = await api.hermes.status();
      status.innerHTML = statusBadge(result);
      if (!result.ready) {
        error.classList.remove("hidden");
        errorText.textContent = result.error || t("hermes.probe", { status: result.status || 0 });
      }
    } catch (e) {
      status.innerHTML = statusBadge({ ready: false });
      error.classList.remove("hidden");
      errorText.textContent = e.message;
    }
  },
};
