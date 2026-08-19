// DeepSeek Harness — the dsh web UI embedded behind the authenticated /dsh
// proxy, exactly the Hermes Control pattern: the upstream's own full
// interface, an availability badge, reload and full-screen escape hatches.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { qs, toast } from "../ui.js";
import { t } from "../i18n.js";

function statusBadge(status) {
  if (!status) return `<span class="badge neutral"><span class="dot"></span>${t("dsh.checking")}</span>`;
  if (status.ready) return `<span class="badge success"><span class="dot"></span>${t("dsh.online")}</span>`;
  return `<span class="badge error"><span class="dot"></span>${t("dsh.offline")}</span>`;
}

export default {
  title: "DeepSeek Harness",
  render: () => `
    <div class="hermes-control">
      <div class="page-head hermes-head">
        <div>
          <div class="page-title">${t("dsh.title")}</div>
          <div class="page-sub">${t("dsh.sub")}</div>
        </div>
        <div class="spacer"></div>
        <div id="dshStatus">${statusBadge()}</div>
        <button class="icon-btn" id="dshReload" title="${t("dsh.reload")}">${icon("refresh")}</button>
        <a class="btn btn-secondary" href="/dsh/" target="_blank" rel="noopener">${icon("external")}${t("dsh.fullscreen")}</a>
      </div>
      <div class="hermes-frame-shell">
        <div class="hermes-frame-loading" id="dshLoading">
          <span class="spinner"></span><span>${t("dsh.connecting")}</span>
        </div>
        <iframe
          id="dshFrame"
          class="hermes-frame"
          src="/dsh/"
          title="DeepSeek Harness"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      </div>
      <div class="alert error hidden" id="dshError">
        <span class="a-ico">${icon("alert")}</span>
        <div class="a-body"><div class="a-title">${t("dsh.notResponding")}</div><div class="a-desc" id="dshErrorText"></div></div>
      </div>
    </div>`,
  mount: async (root) => {
    const frame = qs("#dshFrame", root);
    const loading = qs("#dshLoading", root);
    const status = qs("#dshStatus", root);
    const error = qs("#dshError", root);
    const errorText = qs("#dshErrorText", root);

    frame.addEventListener("load", () => loading?.classList.add("hidden"));
    qs("#dshReload", root).onclick = async () => {
      loading?.classList.remove("hidden");
      frame.src = `/dsh/?reload=${Date.now()}`;
      try {
        const result = await api.dsh.status();
        status.innerHTML = statusBadge(result);
        toast(result.ready ? "success" : "error", result.ready ? t("dsh.online") : t("dsh.offline"));
      } catch (e) {
        status.innerHTML = statusBadge({ ready: false });
        toast("error", t("dsh.checkFailed"), e.message);
      }
    };

    try {
      const result = await api.dsh.status();
      status.innerHTML = statusBadge(result);
      if (!result.ready) {
        error.classList.remove("hidden");
        errorText.textContent = result.error || t("dsh.probe", { status: result.status || 0 });
      }
    } catch (e) {
      status.innerHTML = statusBadge({ ready: false });
      error.classList.remove("hidden");
      errorText.textContent = e.message;
    }
  },
};
