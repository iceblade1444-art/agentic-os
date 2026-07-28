import { api } from "../api.js";
import { icon } from "../icons.js";
import { closeOverlay, confirmDialog, esc, openModal, toast } from "../ui.js";
import { getLocale, t } from "../i18n.js";

const dateLabel = (value) => {
  if (!value) return t("member.noDue");
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" }).format(date);
};

const updatedLabel = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" }).format(date);
};

const loading = () => `<div class="member-loading"><span></span><span></span><span></span></div>`;
const failure = (message) => `<div class="empty member-empty">${icon("alert")}<h4>${t("member.loadFailed")}</h4><p>${esc(message)}</p></div>`;

function taskForm(task = {}) {
  return `
    <div class="field"><label class="label" for="memberTaskTitle">${t("member.title")}</label><input class="input" id="memberTaskTitle" maxlength="160" value="${esc(task.title || "")}" autofocus/></div>
    <div class="field"><label class="label" for="memberTaskDetail">${t("member.details")}</label><textarea class="textarea" id="memberTaskDetail" maxlength="4000" rows="5">${esc(task.detail || "")}</textarea></div>
    <div class="member-form-row">
      <div class="field"><label class="label" for="memberTaskPriority">${t("member.priority")}</label><select class="select" id="memberTaskPriority">
        ${["low", "normal", "high"].map((value) => `<option value="${value}" ${(task.priority || "normal") === value ? "selected" : ""}>${t(`member.priority.${value}`)}</option>`).join("")}
      </select></div>
      <div class="field"><label class="label" for="memberTaskDue">${t("member.dueDate")}</label><input class="input" id="memberTaskDue" type="date" value="${esc(task.dueDate || "")}"/></div>
    </div>
    <div class="field-error hidden" data-form-error></div>`;
}

function openTaskEditor(task, onSaved) {
  const editing = !!task?.id;
  openModal({
    title: t(editing ? "member.editTask" : "member.newTask"),
    width: 560,
    body: taskForm(task),
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" data-save>${icon("save")}<span>${t(editing ? "member.saveChanges" : "member.createTask")}</span></button>`,
    onMount: (modal) => {
      modal.querySelector("[data-save]").onclick = async () => {
        const button = modal.querySelector("[data-save]");
        const error = modal.querySelector("[data-form-error]");
        const body = {
          title: modal.querySelector("#memberTaskTitle").value,
          detail: modal.querySelector("#memberTaskDetail").value,
          priority: modal.querySelector("#memberTaskPriority").value,
          dueDate: modal.querySelector("#memberTaskDue").value,
        };
        button.classList.add("loading");
        try {
          const saved = editing ? await api.member.updateTask(task.id, body) : await api.member.createTask(body);
          closeOverlay();
          toast("success", t(editing ? "member.taskUpdated" : "member.taskCreated"));
          onSaved(saved);
        } catch (saveError) {
          error.textContent = saveError.message;
          error.classList.remove("hidden");
          button.classList.remove("loading");
        }
      };
    },
  });
}

function taskRow(task, compact = false) {
  return `<article class="member-task-row ${compact ? "compact" : ""}" data-task-id="${esc(task.id)}">
    <span class="member-priority ${esc(task.priority)}"></span>
    <div class="member-task-copy"><strong>${esc(task.title)}</strong>${task.detail ? `<p>${esc(task.detail)}</p>` : ""}</div>
    <span class="member-due ${task.dueDate && task.dueDate <= new Date().toISOString().slice(0, 10) ? "due" : ""}">${icon("calendar")}${esc(dateLabel(task.dueDate))}</span>
    ${compact ? `<span class="badge ${task.status === "doing" ? "warning" : "neutral"}">${t(task.status === "doing" ? "member.status.doing" : "member.status.todo")}</span>` : ""}
  </article>`;
}

export const memberHome = {
  title: "Home",
  render: () => `<div id="memberHome">${loading()}</div>`,
  async mount(root) {
    try {
      const data = await api.member.dashboard();
      const name = esc(data.account?.name?.split(/\s+/)[0] || "there");
      root.innerHTML = `
        <div class="page-head member-welcome">
          <div><p class="member-eyebrow">${t("member.workspace")}</p><h1 class="page-title">${t("member.hello", { name })}</h1><p class="page-sub">${t("member.homeSubtitle")}</p></div>
          <div class="spacer"></div>
          <a class="btn btn-secondary" href="#/chat">${icon("chat")}${t("member.askMila")}</a>
          <a class="btn btn-primary" href="#/my-tasks/new">${icon("plus")}${t("member.newTask")}</a>
        </div>
        <div class="grid cols-4 member-stats">
          ${[
            [t("member.openTasks"), data.counts.open, "evaluations"],
            [t("member.status.doing"), data.counts.doing, "activity"],
            [t("member.dueNow"), data.counts.due, "calendar"],
            [t("member.notes"), data.counts.notes, "knowledge"],
          ].map(([label, value, glyph]) => `<div class="stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ico">${icon(glyph)}</span></div><div class="stat-value">${value}</div></div>`).join("")}
        </div>
        <div class="member-home-grid">
          <section class="card member-section">
            <div class="card-head"><h3>${t("member.focus")}</h3><div class="spacer"></div><a class="btn btn-ghost sm" href="#/my-tasks">${t("member.allTasks")} ${icon("arrowright")}</a></div>
            <div class="member-list">${data.tasks.length ? data.tasks.map((task) => taskRow(task, true)).join("") : `<div class="member-inline-empty">${icon("check")}<span>${t("member.noOpenTasks")}</span></div>`}</div>
          </section>
          <section class="card member-section">
            <div class="card-head"><h3>${t("member.recentNotes")}</h3><div class="spacer"></div><a class="btn btn-ghost sm" href="#/my-notes">${t("member.allNotes")} ${icon("arrowright")}</a></div>
            <div class="member-note-list">${data.notes.length ? data.notes.map((note) => `<a href="#/my-notes/${encodeURIComponent(note.id)}"><span>${icon("file")}</span><div><strong>${esc(note.title)}</strong><small>${t("personal.updated", { date: updatedLabel(note.updatedAt) })}</small></div>${icon("chevright")}</a>`).join("") : `<div class="member-inline-empty">${icon("file")}<span>${t("member.noNotesYet")}</span></div>`}</div>
          </section>
        </div>`;
    } catch (error) {
      root.innerHTML = failure(error.message);
    }
  },
};

let tasksCache = [];

function tasksView() {
  const columns = [
    ["todo", t("member.status.todo"), "list"],
    ["doing", t("member.status.doing"), "activity"],
    ["done", t("member.status.done"), "check"],
  ];
  return `<div class="page-head">
    <div><h1 class="page-title">${t("member.myTasks")}</h1><p class="page-sub">${t("member.tasksSubtitle")}</p></div><div class="spacer"></div>
    <button class="btn btn-primary" data-new-task>${icon("plus")}${t("member.newTask")}</button>
  </div>
  <div class="member-task-board">
    ${columns.map(([status, label, glyph]) => {
      const tasks = tasksCache.filter((task) => task.status === status);
      return `<section class="member-task-column" data-status="${status}">
        <header><span>${icon(glyph)}</span><strong>${label}</strong><small>${tasks.length}</small></header>
        <div>${tasks.length ? tasks.map((task) => `<article class="member-task-card" data-task="${esc(task.id)}">
          <div class="member-task-card-head"><span class="member-priority ${esc(task.priority)}"></span><span>${t(`member.priority.${task.priority}`)}</span><button class="icon-btn" data-edit="${esc(task.id)}" title="${t("member.editTask")}">${icon("edit")}</button></div>
          <h3>${esc(task.title)}</h3>${task.detail ? `<p>${esc(task.detail)}</p>` : ""}
          <footer><span>${icon("calendar")}${esc(dateLabel(task.dueDate))}</span><select class="select member-status" data-status-id="${esc(task.id)}" aria-label="Task status">
            ${columns.map(([value, text]) => `<option value="${value}" ${status === value ? "selected" : ""}>${text}</option>`).join("")}
          </select><button class="icon-btn danger" data-delete="${esc(task.id)}" title="${t("member.deleteTask")}">${icon("trash")}</button></footer>
        </article>`).join("") : `<div class="member-column-empty">${t("member.noTasks")}</div>`}</div>
      </section>`;
    }).join("")}
  </div>`;
}

function wireTasks(root) {
  root.querySelector("[data-new-task]")?.addEventListener("click", () => openTaskEditor(null, (saved) => {
    tasksCache.unshift(saved);
    root.innerHTML = tasksView();
    wireTasks(root);
  }));
  root.querySelectorAll("[data-edit]").forEach((button) => button.onclick = () => {
    const task = tasksCache.find((item) => item.id === button.dataset.edit);
    openTaskEditor(task, (saved) => {
      tasksCache = tasksCache.map((item) => item.id === saved.id ? saved : item);
      root.innerHTML = tasksView();
      wireTasks(root);
    });
  });
  root.querySelectorAll("[data-status-id]").forEach((select) => select.onchange = async () => {
    select.disabled = true;
    try {
      const saved = await api.member.updateTask(select.dataset.statusId, { status: select.value });
      tasksCache = tasksCache.map((item) => item.id === saved.id ? saved : item);
      root.innerHTML = tasksView();
      wireTasks(root);
    } catch (error) {
      toast("error", t("member.updateFailed"), error.message);
      select.disabled = false;
    }
  });
  root.querySelectorAll("[data-delete]").forEach((button) => button.onclick = () => confirmDialog({
    title: t("member.deleteTask"),
    message: t("member.deleteTaskText"),
    confirmText: t("system.delete"),
    onConfirm: async () => {
      try {
        await api.member.deleteTask(button.dataset.delete);
        tasksCache = tasksCache.filter((item) => item.id !== button.dataset.delete);
        root.innerHTML = tasksView();
        wireTasks(root);
        toast("success", t("member.taskDeleted"));
      } catch (error) { toast("error", t("member.deleteTaskFailed"), error.message); }
    },
  }));
}

export const memberTasks = {
  title: "My Tasks",
  render: () => `<div id="memberTasks">${loading()}</div>`,
  async mount(root, ctx) {
    try {
      tasksCache = await api.member.tasks();
      root.innerHTML = tasksView();
      wireTasks(root);
      if (ctx.params?.[0] === "new") root.querySelector("[data-new-task]")?.click();
    } catch (error) { root.innerHTML = failure(error.message); }
  },
};

let notesCache = [];
let activeNoteId = "";

function notesView() {
  const active = notesCache.find((note) => note.id === activeNoteId) || notesCache[0] || null;
  if (active) activeNoteId = active.id;
  return `<div class="page-head">
    <div><h1 class="page-title">${t("member.myNotes")}</h1><p class="page-sub">${t("member.notesSubtitle")}</p></div><div class="spacer"></div>
    <button class="btn btn-primary" data-new-note>${icon("plus")}${t("member.newNote")}</button>
  </div>
  <div class="member-notes">
    <aside class="member-note-index">
      ${notesCache.length ? notesCache.map((note) => `<button class="${note.id === active?.id ? "active" : ""}" data-note="${esc(note.id)}"><span>${icon("file")}</span><div><strong>${esc(note.title)}</strong><small>${esc(updatedLabel(note.updatedAt))}</small></div></button>`).join("") : `<div class="member-column-empty">${t("member.noNotes")}</div>`}
    </aside>
    <section class="member-note-editor">
      ${active ? `<div class="member-note-toolbar"><span class="badge neutral">${t("member.savedWorkspace")}</span><div class="spacer"></div><button class="icon-btn danger" data-delete-note="${esc(active.id)}" title="${t("member.deleteNote")}">${icon("trash")}</button></div>
        <input class="member-note-title" id="memberNoteTitle" maxlength="160" value="${esc(active.title)}" aria-label="${t("member.noteTitle")}"/>
        <textarea class="member-note-content" id="memberNoteContent" maxlength="20000" aria-label="${t("member.noteContent")}" placeholder="${t("member.startWriting")}">${esc(active.content)}</textarea>
        <footer><span class="muted" data-note-state>${t("member.saved")}</span><button class="btn btn-primary" data-save-note>${icon("save")}${t("member.save")}</button></footer>`
        : `<div class="empty member-empty">${icon("file")}<h4>${t("member.createFirstNote")}</h4><button class="btn btn-primary" data-new-note-empty>${icon("plus")}${t("member.newNote")}</button></div>`}
    </section>
  </div>`;
}

function openNewNote(root) {
  openModal({
    title: t("member.newNote"),
    width: 480,
    body: `<div class="field"><label class="label" for="newNoteTitle">${t("member.title")}</label><input class="input" id="newNoteTitle" maxlength="160" autofocus/></div><div class="field-error hidden" data-form-error></div>`,
    footer: `<button class="btn btn-secondary" data-close>${t("system.cancel")}</button><button class="btn btn-primary" data-create-note>${icon("plus")}${t("member.create")}</button>`,
    onMount: (modal) => {
      modal.querySelector("[data-create-note]").onclick = async () => {
        const button = modal.querySelector("[data-create-note]");
        button.classList.add("loading");
        try {
          const note = await api.member.createNote({ title: modal.querySelector("#newNoteTitle").value, content: "" });
          notesCache.unshift(note);
          activeNoteId = note.id;
          closeOverlay();
          root.innerHTML = notesView();
          wireNotes(root);
        } catch (error) {
          const message = modal.querySelector("[data-form-error]");
          message.textContent = error.message;
          message.classList.remove("hidden");
          button.classList.remove("loading");
        }
      };
    },
  });
}

function wireNotes(root) {
  root.querySelectorAll("[data-new-note], [data-new-note-empty]").forEach((button) => button.onclick = () => openNewNote(root));
  root.querySelectorAll("[data-note]").forEach((button) => button.onclick = () => {
    activeNoteId = button.dataset.note;
    root.innerHTML = notesView();
    wireNotes(root);
  });
  root.querySelector("[data-save-note]")?.addEventListener("click", async () => {
    const button = root.querySelector("[data-save-note]");
    const state = root.querySelector("[data-note-state]");
    button.classList.add("loading");
    try {
      const saved = await api.member.updateNote(activeNoteId, {
        title: root.querySelector("#memberNoteTitle").value,
        content: root.querySelector("#memberNoteContent").value,
      });
      notesCache = notesCache.map((note) => note.id === saved.id ? saved : note);
      state.textContent = t("member.saved");
      button.classList.remove("loading");
      toast("success", t("member.noteSaved"));
    } catch (error) {
      state.textContent = error.message;
      button.classList.remove("loading");
    }
  });
  root.querySelector("[data-delete-note]")?.addEventListener("click", (event) => {
    const noteId = event.currentTarget.dataset.deleteNote;
    confirmDialog({
      title: t("member.deleteNote"),
      message: t("member.deleteNoteText"),
      confirmText: t("system.delete"),
      onConfirm: async () => {
      try {
        await api.member.deleteNote(noteId);
        notesCache = notesCache.filter((note) => note.id !== noteId);
        activeNoteId = notesCache[0]?.id || "";
        root.innerHTML = notesView();
        wireNotes(root);
        toast("success", t("member.noteDeleted"));
      } catch (error) { toast("error", t("member.deleteNoteFailed"), error.message); }
      },
    });
  });
}

export const memberNotes = {
  title: "My Notes",
  render: () => `<div id="memberNotes">${loading()}</div>`,
  async mount(root, ctx) {
    try {
      notesCache = await api.member.notes();
      activeNoteId = decodeURIComponent(ctx.params?.[0] || notesCache[0]?.id || "");
      root.innerHTML = notesView();
      wireNotes(root);
    } catch (error) { root.innerHTML = failure(error.message); }
  },
};
