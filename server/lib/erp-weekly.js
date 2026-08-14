// The weekly ERP review: numbers with their direction of travel.
//
// The morning brief says what today looks like; this says how the week moved.
// Every Monday morning (owner's timezone) it reads the same live digest the
// brief uses, compares it with the snapshot stored a week earlier, and sends
// the owner a short review — through the inbox, which already rides to their
// Telegram. Then it stores this week's snapshot for next Monday.
//
// The honesty rule is inherited from the digest: a number that could not be
// read is "нет данных", never zero — and a delta against missing data is not a
// delta at all, so it simply is not printed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { creatorUser } from "./auth.js";
import { erpDigest } from "./erp-digest.js";
import { journal } from "./journal.js";
import { onboarding } from "./onboarding.js";
import { pushService } from "./push-service.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const TICK_MS = 10 * 60 * 1000;
// Late enough that the ERP has the weekend booked, early enough to be read
// with the Monday coffee.
const SEND_HOUR = 8;
const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);

function delta(current, previous, { downIsGood = false } = {}) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "";
  const diff = current - previous;
  if (!diff) return " (без изменений за неделю)";
  const arrow = diff > 0 ? "▲" : "▼";
  const tone = (diff < 0) === downIsGood ? "" : "";
  return ` (${arrow} ${Math.abs(diff)} за неделю${tone})`;
}

export function createErpWeekly(options = {}) {
  const digest = options.erpDigest || erpDigest;
  const push = options.pushService || pushService;
  const journalStore = options.journal || journal;
  const settings = options.onboarding || onboarding;
  const creator = options.creatorUser || creatorUser;
  const now = options.now || (() => new Date());
  const file = options.file || path.join(path.resolve(config.dataDir), "erp-weekly.json");
  let timer = null;

  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const write = (value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    hardenRuntimeFile(file, 0o600);
  };

  function compose(current, previous) {
    const lines = [];
    if (Number.isFinite(current.lateOrders)) {
      lines.push(`Просроченные заказы: ${current.lateOrders}${delta(current.lateOrders, previous?.lateOrders, { downIsGood: true })}${current.lateOrdersDetail ? ` — ${current.lateOrdersDetail}` : ""}`);
    } else {
      lines.push("Просроченные заказы: нет данных из ERP");
    }
    if (Number.isFinite(current.finishedGoodsPieces)) {
      lines.push(`Склад готовой продукции: ${current.finishedGoodsPieces} шт${delta(current.finishedGoodsPieces, previous?.finishedGoodsPieces)}`);
    } else {
      lines.push("Склад готовой продукции: нет данных из ERP");
    }
    if (current.financeFlag) lines.push(`Финансы: ${clean(current.financeFlag, 160)}`);
    if (!previous) lines.push("Это первый недельный обзор — динамика появится со следующего понедельника.");
    return lines.join("\n");
  }

  // The local calendar week of a given instant, so "already sent this Monday"
  // survives restarts and clock drift.
  function weekKey(date, timeZone) {
    const local = new Date(date.toLocaleString("en-US", { timeZone }));
    const day = (local.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(local);
    monday.setDate(local.getDate() - day);
    return monday.toLocaleDateString("sv-SE");
  }

  async function tick() {
    const owner = creator();
    const timezone = settings.get(owner)?.profile?.timezone || "Asia/Tashkent";
    const current = now();
    const local = new Date(current.toLocaleString("en-US", { timeZone: timezone }));
    if (local.getDay() !== 1 || local.getHours() < SEND_HOUR) return null;

    const state = read();
    const key = weekKey(current, timezone);
    if (state.lastSentWeek === key) return null;

    const value = await digest.read({ force: true });
    if (!value.available) return null;

    const body = compose(value, state.snapshot);
    const item = { id: `erp_week_${key}`, kind: "erp-weekly", title: "Недельный обзор ERP", body };
    await push.sendInbox(owner.id, item);
    Promise.resolve(journalStore.append({ actor: "ERP-аналитик", kind: "erp", title: "Недельный обзор отправлен" })).catch(() => {});

    write({ lastSentWeek: key, snapshot: { lateOrders: value.lateOrders, finishedGoodsPieces: value.finishedGoodsPieces, storedAt: value.checkedAt } });
    return item;
  }

  function start() {
    if (timer) return;
    const run = () => tick().catch((error) => console.warn(`[erp-weekly] ${error.message}`)).finally(() => { timer = setTimeout(run, TICK_MS); });
    timer = setTimeout(run, TICK_MS);
  }

  return { tick, start, stop: () => { clearTimeout(timer); timer = null; }, compose };
}

export const erpWeekly = createErpWeekly();
