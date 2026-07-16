import { api } from "../api.js";
import { icon } from "../icons.js";
import { qs, toast } from "../ui.js";

function statusBadge(status) {
  if (!status) return `<span class="badge neutral"><span class="dot"></span>Checking</span>`;
  if (status.ready) return `<span class="badge success"><span class="dot"></span>Hermes online</span>`;
  return `<span class="badge error"><span class="dot"></span>Hermes unavailable</span>`;
}

export default {
  title: "Hermes Control",
  render: () => `
    <div class="hermes-control">
      <div class="page-head hermes-head">
        <div>
          <div class="page-title">Hermes Control</div>
          <div class="page-sub">Primary Agentic OS orchestrator and its complete official dashboard.</div>
        </div>
        <div class="spacer"></div>
        <div id="hermesStatus">${statusBadge()}</div>
        <button class="icon-btn" id="hermesReload" title="Reload Hermes Dashboard">${icon("refresh")}</button>
        <a class="btn btn-secondary" href="/hermes/" target="_blank" rel="noopener">${icon("external")}Open full screen</a>
      </div>
      <div class="hermes-frame-shell">
        <div class="hermes-frame-loading" id="hermesLoading">
          <span class="spinner"></span><span>Connecting to Hermes Dashboard...</span>
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
        <div class="a-body"><div class="a-title">Hermes Dashboard is not responding</div><div class="a-desc" id="hermesErrorText"></div></div>
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
        toast(result.ready ? "success" : "error", result.ready ? "Hermes is online" : "Hermes is unavailable");
      } catch (e) {
        status.innerHTML = statusBadge({ ready: false });
        toast("error", "Hermes check failed", e.message);
      }
    };

    try {
      const result = await api.hermes.status();
      status.innerHTML = statusBadge(result);
      if (!result.ready) {
        error.classList.remove("hidden");
        errorText.textContent = result.error || `Dashboard probe returned HTTP ${result.status || 0}.`;
      }
    } catch (e) {
      status.innerHTML = statusBadge({ ready: false });
      error.classList.remove("hidden");
      errorText.textContent = e.message;
    }
  },
};
