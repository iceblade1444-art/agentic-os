// The 15-minute warning: once per event, never for a day, never re-warned
// after a restart.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEventAlerts } from "../server/lib/event-alerts.js";

const OWNER = { id: "creator", name: "Бахадыр", role: "Creator" };
const NOW = new Date("2026-08-18T06:50:00.000Z"); // 11:50 Tashkent

function fixture({ events = [], file, when = NOW } = {}) {
  const dir = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), "aos-events-"));
  const stateFile = file || path.join(dir, "state.json");
  const inbox = [];
  const instance = createEventAlerts({
    file: stateFile,
    googleWorkspace: { status: () => ({ connected: true }), calendarEvents: async () => ({ events }) },
    pushService: { sendInbox: async (userId, item) => { inbox.push({ userId, item }); return {}; } },
    onboarding: { get: () => ({ profile: { completedAt: "2026-01-01", timezone: "Asia/Tashkent" } }) },
    users: { list: () => [] },
    creatorUser: () => OWNER,
    now: () => when,
  });
  return { instance, inbox, file: stateFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const MEETING = { id: "evt1", title: "Совещание с цехом", start: "2026-08-18T07:00:00.000Z", allDay: false };

test("a meeting entering the window warns once, with the local clock time", async () => {
  const f = fixture({ events: [MEETING, { id: "evt2", title: "Далёкое", start: "2026-08-18T09:00:00.000Z" }, { id: "evt3", title: "Весь день", start: "2026-08-18", allDay: true }] });
  const sent = await f.instance.tick();
  assert.deepEqual(sent, ["creator:evt1"]);
  assert.match(f.inbox[0].item.title, /через 10 мин: Совещание с цехом/);
  assert.match(f.inbox[0].item.body, /Начало в 12:00/);

  // The same tick five minutes later does not nag.
  assert.equal((await f.instance.tick()).length, 0);
  f.cleanup();
});

test("a restart at 11:55 does not re-warn about the noon meeting", async () => {
  const first = fixture({ events: [MEETING] });
  await first.instance.tick();

  const second = fixture({ events: [MEETING], file: first.file, when: new Date("2026-08-18T06:55:00.000Z") });
  assert.equal((await second.instance.tick()).length, 0, "the alert record survives the process");
  first.cleanup();
});

test("no calendar, no noise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-events-"));
  const inbox = [];
  const instance = createEventAlerts({
    file: path.join(dir, "state.json"),
    googleWorkspace: { status: () => ({ connected: false }), calendarEvents: async () => { throw new Error("must not be called"); } },
    pushService: { sendInbox: async (userId, item) => { inbox.push(item); return {}; } },
    onboarding: { get: () => ({ profile: { completedAt: "2026-01-01" } }) },
    users: { list: () => [] },
    creatorUser: () => OWNER,
    now: () => NOW,
  });
  assert.equal((await instance.tick()).length, 0);
  assert.equal(inbox.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
