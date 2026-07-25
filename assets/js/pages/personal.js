import { api } from "../api.js";
import { icon } from "../icons.js";
import { esc, toast } from "../ui.js";

const tabs = [
  ["today", "Сегодня", "home"],
  ["soul", "MILA и SOUL", "brain"],
  ["memory", "Память", "knowledge"],
  ["approvals", "Подтверждения", "guardrails"],
  ["account", "Аккаунт", "user"],
];

let data = null;
let activeTab = "today";

const stateLabel = (value) => value === "connected" ? "Подключено" : value === "setup_required" ? "Настроить" : "Не подключено";
const stateTone = (value) => value === "connected" ? "connected" : value === "setup_required" ? "warning" : "muted";
const shortDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(date);
};
const dueLabel = (value) => value ? new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00`)) : "Без срока";

function shell() {
  return `<div class="personal-page">
    <div class="page-head personal-heading">
      <div><p class="member-eyebrow">Личное пространство</p><h1 class="page-title">Personal</h1><p class="page-sub">Ваш день, память и действия агентов в одном месте.</p></div>
      <div class="spacer"></div>
      <a class="btn btn-secondary" href="#/chat">${icon("chat")}Спросить MILA</a>
      <button class="btn btn-primary" data-personal-new>${icon("plus")}Новая задача</button>
    </div>
    <nav class="personal-tabs" aria-label="Разделы Personal">
      ${tabs.map(([id, label, glyph]) => `<button type="button" data-personal-tab="${id}" class="${id === activeTab ? "active" : ""}">${icon(glyph)}<span>${label}</span>${id === "approvals" && data?.briefing?.approvalCount ? `<b>${data.briefing.approvalCount}</b>` : ""}</button>`).join("")}
    </nav>
    <div id="personalContent">${content()}</div>
  </div>`;
}

function taskItem(task) {
  return `<article class="personal-task">
    <span class="member-priority ${esc(task.priority)}"></span>
    <div><strong>${esc(task.title)}</strong><small>${task.status === "doing" ? "В работе" : "К выполнению"} · ${esc(dueLabel(task.dueDate))}</small></div>
    <button class="icon-btn tip" data-personal-done="${esc(task.id)}" data-tip="Отметить выполненной" aria-label="Выполнить">${icon("check")}</button>
  </article>`;
}

function approvalTitle(item) {
  return item?.title || item?.description || item?.action || item?.summary || item?.id || "Действие агента";
}

function approvalItem(item, compact = false) {
  const id = item?.id || item?.approval_id || "";
  return `<article class="personal-approval ${compact ? "compact" : ""}">
    <span>${icon("guardrails")}</span>
    <div><strong>${esc(approvalTitle(item))}</strong><small>${esc(item?.agent || item?.actor || "Hermes")} · требуется решение</small></div>
    ${compact ? `<a href="#/personal/approvals" class="btn btn-ghost sm">Открыть</a>` : `<div class="personal-approval-actions"><button class="btn btn-secondary sm" data-approval="${esc(id)}" data-decision="reject">Отклонить</button><button class="btn btn-primary sm" data-approval="${esc(id)}" data-decision="approve">Одобрить</button></div>`}
  </article>`;
}

function sourceRow(name, key, glyph, target = "") {
  const value = data.sources[key];
  const body = `<span class="personal-source-icon">${icon(glyph)}</span><span><strong>${name}</strong><small class="${stateTone(value)}">${stateLabel(value)}</small></span>${icon("chevright")}`;
  return target ? `<a class="personal-source" href="${target}">${body}</a>` : `<div class="personal-source disabled">${body}</div>`;
}

function todayView() {
  const focus = data.briefing.focus;
  return `<section class="personal-today">
    <div class="personal-briefing">
      <div class="personal-briefing-icon">${icon("sparkles")}</div>
      <div><span>Брифинг дня</span><h2>${esc(data.briefing.greeting)}</h2><p>${esc(data.briefing.summary)}</p></div>
      <div class="personal-load"><strong>${data.briefing.load}%</strong><span>загрузка</span><i><b style="width:${data.briefing.load}%"></b></i></div>
    </div>
    <form class="personal-capture" data-capture-form>
      ${icon("command")}<input maxlength="160" data-capture-input placeholder="Быстро добавьте задачу на сегодня…"/>
      <button class="btn btn-primary" type="submit">${icon("plus")}Добавить</button>
    </form>
    <div class="personal-today-grid">
      <section class="personal-panel personal-focus">
        <header><div><span>План</span><h3>Приоритетные задачи</h3></div><a href="#/my-tasks">Все задачи ${icon("arrowright")}</a></header>
        ${focus ? `<div class="personal-focus-callout"><span>Главный фокус</span><strong>${esc(focus.title)}</strong><small>${esc(focus.detail || "Продвиньте эту задачу сегодня.")}</small></div>` : ""}
        <div class="personal-stack">${data.tasks.length ? data.tasks.slice(0, 5).map(taskItem).join("") : `<div class="personal-empty">${icon("check")}<strong>Открытых задач нет</strong><span>Можно спокойно выбрать следующий фокус.</span></div>`}</div>
      </section>
      <section class="personal-panel">
        <header><div><span>Контроль</span><h3>Ожидают подтверждения</h3></div><button class="link-button" data-open-tab="approvals">Все</button></header>
        <div class="personal-stack">${data.approvals.length ? data.approvals.slice(0, 3).map((item) => approvalItem(item, true)).join("") : `<div class="personal-empty">${icon("guardrails")}<strong>Ничего не ожидает</strong><span>${data.approvalsAvailable ? "Агенты не запрашивали важных действий." : "Очередь доступна владельцу и администратору."}</span></div>`}</div>
      </section>
      <section class="personal-panel">
        <header><div><span>Контекст</span><h3>Последняя память</h3></div><button class="link-button" data-open-tab="memory">Открыть</button></header>
        <div class="personal-note-stream">${data.notes.length ? data.notes.slice(0, 4).map((note) => `<a href="#/my-notes/${encodeURIComponent(note.id)}">${icon("file")}<span><strong>${esc(note.title)}</strong><small>Обновлено ${esc(shortDate(note.updatedAt))}</small></span>${icon("chevright")}</a>`).join("") : `<div class="personal-empty">${icon("file")}<strong>Память пока пуста</strong><span>Создайте заметку текстом или через MILA.</span></div>`}</div>
      </section>
    </div>
    <section class="personal-sources">
      <header><div><span>Источники дня</span><h3>Подключения Personal</h3></div></header>
      <div>${sourceRow("Личные задачи", "tasks", "evaluations", "#/my-tasks")}${sourceRow("Заметки и память", "notes", "knowledge", "#/my-notes")}${sourceRow("MILA", "mila", "mic", "#/chat")}${sourceRow("Google Calendar", "calendar", "calendar")}${sourceRow("Почта", "inbox", "mail")}</div>
    </section>
  </section>`;
}

function soulView() {
  const profile = data.profile || {};
  return `<div class="personal-split">
    <section class="personal-panel">
      <header><div><span>Поведение ассистента</span><h3>Настройки MILA</h3></div></header>
      <form class="personal-profile-form" data-profile-form>
        <div class="personal-form-grid">
          <div class="field"><label class="label">Язык</label><select class="select" data-profile-locale>
            <option value="ru-RU" ${profile.locale === "ru-RU" ? "selected" : ""}>Русский</option>
            <option value="uz-UZ" ${profile.locale === "uz-UZ" ? "selected" : ""}>O‘zbekcha</option>
            <option value="en-US" ${profile.locale === "en-US" ? "selected" : ""}>English</option>
          </select></div>
          <div class="field"><label class="label">Часовой пояс</label><input class="input" data-profile-timezone maxlength="80" value="${esc(profile.timezone || "Asia/Tashkent")}"/></div>
        </div>
        <div class="field"><label class="label">Мой рабочий фокус</label><input class="input" data-profile-focus maxlength="160" value="${esc(profile.roleFocus || "")}" placeholder="Например: развитие продукта и управление командой"/></div>
        <div class="personal-form-grid">
          <div class="field"><label class="label">Стиль MILA</label><select class="select" data-profile-style>
            ${[["assistant", "Ассистент"], ["friend", "Друг"], ["operator", "Оператор"], ["mentor", "Наставник"]].map(([value, label]) => `<option value="${value}" ${profile.assistantStyle === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></div>
          <div class="field"><label class="label">Длина голосовых ответов</label><select class="select" data-profile-length>
            <option value="brief" ${profile.responseLength === "brief" ? "selected" : ""}>Коротко</option>
            <option value="balanced" ${profile.responseLength === "balanced" ? "selected" : ""}>Сбалансированно</option>
          </select></div>
        </div>
        <footer><span data-profile-state>Изменения синхронизируются с web и mobile.</span><button class="btn btn-primary" type="submit">${icon("save")}Сохранить</button></footer>
      </form>
    </section>
    <section class="personal-panel personal-soul-preview">
      <header><div><span>Долговременный профиль</span><h3>SOUL.md</h3></div><button class="btn btn-secondary sm" data-sync-soul>${icon("refresh")}Синхронизировать</button></header>
      <div class="personal-file-path">${icon("file")}<code>${esc(data.soul.path)}</code></div>
      <pre>${esc(data.soul.content)}</pre>
    </section>
  </div>`;
}

function memoryView(query = "") {
  const normalized = query.trim().toLowerCase();
  const notes = normalized ? data.notes.filter((note) => `${note.title} ${note.content || ""}`.toLowerCase().includes(normalized)) : data.notes;
  return `<section class="personal-panel personal-memory">
    <header><div><span>Личный контекст</span><h3>Память и заметки</h3></div><a class="btn btn-primary sm" href="#/my-notes">${icon("plus")}Новая заметка</a></header>
    <div class="personal-memory-search">${icon("search")}<input data-memory-search value="${esc(query)}" placeholder="Найти по смыслу или названию…"/></div>
    <div class="personal-memory-grid">${notes.length ? notes.map((note) => `<a href="#/my-notes/${encodeURIComponent(note.id)}"><span class="personal-memory-glyph">${icon("file")}</span><div><strong>${esc(note.title)}</strong><p>${esc((note.content || "Пустая заметка").slice(0, 180))}</p><small>Обновлено ${esc(shortDate(note.updatedAt))}</small></div></a>`).join("") : `<div class="personal-empty wide">${icon("search")}<strong>Ничего не найдено</strong><span>Измените запрос или создайте новую заметку.</span></div>`}</div>
    <div class="personal-context-callout">${icon("network")}<div><strong>Obsidian остаётся общей библиотекой агентов</strong><span>Личные заметки изолированы по аккаунту. Владелец может открыть полный граф Obsidian отдельно.</span></div>${api.auth.canAdmin ? `<a class="btn btn-secondary sm" href="#/knowledge">Открыть граф</a>` : ""}</div>
  </section>`;
}

function approvalsView() {
  return `<section class="personal-panel personal-approvals">
    <header><div><span>Безопасность действий</span><h3>Очередь подтверждений</h3></div><span class="badge ${data.approvals.length ? "warning" : "success"}">${data.approvals.length} ожидают</span></header>
    <div class="personal-approval-list">${data.approvals.length ? data.approvals.map((item) => approvalItem(item)).join("") : `<div class="personal-empty wide">${icon("guardrails")}<strong>Все под контролем</strong><span>${data.approvalsAvailable ? "Нет действий, требующих вашего решения." : "Для обычного пользователя действия выполняются только в его личной области."}</span></div>`}</div>
    <div class="personal-policy">${icon("info")}MILA и Hermes не должны менять файлы, аккаунты, деньги, настройки или публичные сервисы без явного подтверждения.</div>
  </section>`;
}

function accountView() {
  const account = data.account;
  return `<div class="personal-account-grid">
    <section class="personal-panel personal-account-card">
      <header><div><span>Профиль</span><h3>Единый аккаунт</h3></div><span class="badge success">Активен</span></header>
      <div class="personal-account-identity"><span>${esc((account.name || "U").slice(0, 1).toUpperCase())}</span><div><h2>${esc(account.name)}</h2><p>${esc(account.email || "Creator account")}</p></div></div>
      <dl><div><dt>Роль</dt><dd>${esc(account.role)}</dd></div><div><dt>Рабочее пространство</dt><dd>${esc(data.workspace.name)}</dd></div><div><dt>Язык</dt><dd>${esc(data.profile.locale || "ru-RU")}</dd></div><div><dt>Часовой пояс</dt><dd>${esc(data.profile.timezone || "Asia/Tashkent")}</dd></div></dl>
    </section>
    <section class="personal-panel">
      <header><div><span>Синхронизация</span><h3>Web и MILA Mobile</h3></div></header>
      <div class="personal-device-row">${icon("cloud")}<div><strong>Серверный профиль</strong><span>Задачи, заметки и SOUL хранятся на Agentic OS.</span></div><span class="badge success">Подключено</span></div>
      <div class="personal-device-row">${icon("mic")}<div><strong>MILA Voice</strong><span>Использует тот же пользовательский аккаунт и личный SOUL.</span></div><span class="badge success">Подключено</span></div>
      <div class="personal-device-row">${icon("shield")}<div><strong>Активные сессии</strong><span>Индивидуальное управление устройствами появится на следующем этапе.</span></div><span class="badge neutral">Запланировано</span></div>
      <a class="btn btn-secondary" href="#/settings">${icon("settings")}Настройки аккаунта</a>
    </section>
  </div>`;
}

function content() {
  if (!data) return `<div class="member-loading"><span></span><span></span><span></span></div>`;
  if (activeTab === "soul") return soulView();
  if (activeTab === "memory") return memoryView();
  if (activeTab === "approvals") return approvalsView();
  if (activeTab === "account") return accountView();
  return todayView();
}

function openTab(root, tab) {
  activeTab = tabs.some(([id]) => id === tab) ? tab : "today";
  root.innerHTML = shell();
  wire(root);
}

async function reload(root, tab = activeTab) {
  data = await api.personal.dashboard();
  openTab(root, tab);
}

function wire(root) {
  root.querySelectorAll("[data-personal-tab]").forEach((button) => button.onclick = () => openTab(root, button.dataset.personalTab));
  root.querySelectorAll("[data-open-tab]").forEach((button) => button.onclick = () => openTab(root, button.dataset.openTab));
  root.querySelector("[data-personal-new]")?.addEventListener("click", () => {
    location.hash = "#/my-tasks/new";
  });
  root.querySelector("[data-capture-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = root.querySelector("[data-capture-input]");
    const title = input.value.trim();
    if (title.length < 2) return input.focus();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await api.member.createTask({ title, status: "todo", priority: "normal" });
      toast("success", "Задача добавлена");
      await reload(root, "today");
    } catch (error) {
      button.disabled = false;
      toast("error", "Не удалось создать задачу", error.message);
    }
  });
  root.querySelectorAll("[data-personal-done]").forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      await api.member.updateTask(button.dataset.personalDone, { status: "done" });
      await reload(root, "today");
      toast("success", "Задача выполнена");
    } catch (error) { button.disabled = false; toast("error", "Не удалось обновить задачу", error.message); }
  });
  root.querySelector("[data-profile-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const state = root.querySelector("[data-profile-state]");
    button.disabled = true;
    state.textContent = "Сохраняю и синхронизирую SOUL.md…";
    try {
      const current = await api.onboarding.get();
      await api.onboarding.save({
        profile: {
          locale: root.querySelector("[data-profile-locale]").value,
          timezone: root.querySelector("[data-profile-timezone]").value,
          roleFocus: root.querySelector("[data-profile-focus]").value,
          assistantStyle: root.querySelector("[data-profile-style]").value,
          responseLength: root.querySelector("[data-profile-length]").value,
        },
        ...(current.canEditWorkspace ? { workspace: current.workspace } : {}),
      });
      await reload(root, "soul");
      toast("success", "Профиль MILA обновлён", "SOUL.md синхронизирован с Obsidian.");
    } catch (error) {
      button.disabled = false;
      state.textContent = error.message;
      toast("error", "Не удалось сохранить профиль", error.message);
    }
  });
  root.querySelector("[data-sync-soul]")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api.onboarding.sync();
      await reload(root, "soul");
      toast("success", "SOUL.md синхронизирован");
    } catch (error) { event.currentTarget.disabled = false; toast("error", "Синхронизация не выполнена", error.message); }
  });
  const search = root.querySelector("[data-memory-search]");
  if (search) search.oninput = () => {
    const host = root.querySelector(".personal-memory-grid");
    const temp = document.createElement("div");
    temp.innerHTML = memoryView(search.value);
    host.replaceWith(temp.querySelector(".personal-memory-grid"));
  };
  root.querySelectorAll("[data-approval]").forEach((button) => button.onclick = async () => {
    const id = button.dataset.approval;
    if (!id) return toast("error", "Не найден ID подтверждения");
    root.querySelectorAll(`[data-approval="${CSS.escape(id)}"]`).forEach((item) => { item.disabled = true; });
    try {
      await api.pulse.decideApproval(id, button.dataset.decision);
      await reload(root, "approvals");
      toast("success", button.dataset.decision === "approve" ? "Действие одобрено" : "Действие отклонено");
    } catch (error) { await reload(root, "approvals"); toast("error", "Решение не применено", error.message); }
  });
}

const personal = {
  title: "Personal",
  render: () => `<div id="personalPage"><div class="member-loading"><span></span><span></span><span></span></div></div>`,
  async mount(root, ctx) {
    try {
      activeTab = ctx.params?.[0] || "today";
      data = await api.personal.dashboard();
      root.innerHTML = shell();
      wire(root);
    } catch (error) {
      root.innerHTML = `<div class="empty member-empty">${icon("alert")}<h4>Personal недоступен</h4><p>${esc(error.message)}</p></div>`;
    }
  },
};

export default personal;
