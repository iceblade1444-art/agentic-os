import { api } from "../api.js";
import { icon } from "../icons.js";
import { esc, toast } from "../ui.js";
import { getLocale, t } from "../i18n.js";

let filter = "";
let snapshot = { items: [], unread: 0 };

const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date);
};

const empty = () => `
  <div class="empty member-empty member-inbox-empty">
    ${icon("inbox")}
    <h4>${t("inbox.empty")}</h4>
    <p>${t("inbox.emptyHint")}</p>
  </div>`;

const itemView = (item) => `
  <article class="member-inbox-item ${item.status === "unread" ? "unread" : ""}" data-id="${esc(item.id)}">
    <span class="member-inbox-type ${esc(item.type)}">${icon(item.type === "reminder" || item.type === "calendar" ? "bell" : "inbox")}</span>
    <div class="member-inbox-copy">
      <header><strong>${esc(item.title || t("nav.mila"))}</strong><time>${esc(formatDate(item.createdAt))}</time></header>
      ${item.body ? `<p>${esc(item.body)}</p>` : ""}
      <footer>
        <span class="badge">${esc(item.type)}</span>
        ${item.status === "unread" ? `<button class="link-button" data-read>${t("inbox.markRead")}</button>` : ""}
        ${item.status !== "archived" ? `<button class="link-button" data-archive>${t("inbox.archive")}</button>` : ""}
        ${item.route ? `<a class="link-button" href="#/${esc(item.route.replace(/^#?\/?/, ""))}">${t("inbox.open")}</a>` : ""}
      </footer>
    </div>
  </article>`;

function view() {
  return `
    <section class="member-inbox-page">
      <div class="page-head">
        <div><h1>${t("inbox.title")}</h1><p>${t("inbox.subtitle")}</p></div>
        ${snapshot.unread ? `<span class="member-inbox-count">${snapshot.unread}</span>` : ""}
      </div>
      <div class="member-inbox-filters" role="tablist">
        ${[["", "all"], ["unread", "unread"], ["read", "read"], ["archived", "archived"]]
          .map(([value, key]) => `<button class="${filter === value ? "active" : ""}" data-filter="${value}">${t(`inbox.${key}`)}</button>`).join("")}
      </div>
      <div class="member-inbox-list">${snapshot.items.length ? snapshot.items.map(itemView).join("") : empty()}</div>
    </section>`;
}

async function load(root) {
  snapshot = await api.member.inbox(filter, 100);
  root.innerHTML = view();
  wire(root);
}

function wire(root) {
  root.querySelectorAll("[data-filter]").forEach((button) => {
    button.onclick = async () => {
      filter = button.dataset.filter;
      try { await load(root); } catch (error) { toast("error", t("member.loadFailed"), error.message); }
    };
  });
  root.querySelectorAll("[data-read], [data-archive]").forEach((button) => {
    button.onclick = async () => {
      const id = button.closest("[data-id]")?.dataset.id;
      if (!id) return;
      try {
        await api.member.updateInboxItem(id, { status: button.hasAttribute("data-read") ? "read" : "archived" });
        await load(root);
      } catch (error) { toast("error", t("member.loadFailed"), error.message); }
    };
  });
}

export default {
  title: "Inbox",
  render: () => `<div class="member-loading"><span></span><span></span><span></span></div>`,
  async mount(root) {
    try { await load(root); }
    catch (error) { root.innerHTML = `<div class="empty member-empty">${icon("alert")}<h4>${t("member.loadFailed")}</h4><p>${esc(error.message)}</p></div>`; }
  },
};
