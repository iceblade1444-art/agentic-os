// ERP anomalies: a sharp move gets said the day it happens.
//
// The weekly review shows direction; this watches for jumps. Twice an hour it
// reads the cached digest, compares against yesterday's stored snapshot, and
// alerts the owner when a number moved beyond its threshold: late orders up by
// three or more, finished goods down by a fifth. One alert per metric per day —
// a metric that stays bad stays said, but not repeated every thirty minutes.
//
// The same honesty inheritance as everything ERP: missing data is not a value,
// so it can neither trigger an alert nor silently clear one.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { creatorUser } from "./auth.js";
import { erpDigest } from "./erp-digest.js";
import { onboarding } from "./onboarding.js";
import { pushService } from "./push-service.js";
import { hardenRuntimeFile } from "./runtime-files.js";

const TICK_MS = 30 * 60 * 1000;
const LATE_ORDER_JUMP = 3;
const FINISHED_GOODS_DROP_RATIO = 0.2;

export function createErpAnomalies(options = {}) {
  const digest = options.erpDigest || erpDigest;
  const push = options.pushService || pushService;
  const settings = options.onboarding || onboarding;
  const creator = options.creatorUser || creatorUser;
  const now = options.now || (() => new Date());
  const file = options.file || path.join(path.resolve(config.dataDir), "erp-anomalies.json");
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

  function localDay(date, timeZone) {
    return date.toLocaleDateString("sv-SE", { timeZone });
  }

  async function tick() {
    const owner = creator();
    const timezone = settings.get(owner)?.profile?.timezone || "Asia/Tashkent";
    const today = localDay(now(), timezone);
    const state = read();
    const value = await digest.read();
    if (!value.available) return [];

    const alerts = [];
    const alerted = state.alerted?.date === today ? state.alerted : { date: today, metrics: [] };

    const previousLate = state.baseline?.lateOrders;
    if (
      Number.isFinite(value.lateOrders) && Number.isFinite(previousLate)
      && value.lateOrders - previousLate >= LATE_ORDER_JUMP
      && !alerted.metrics.includes("lateOrders")
    ) {
      alerts.push({
        metric: "lateOrders",
        title: "ERP: скачок просрочек",
        body: `Просроченных заказов стало ${value.lateOrders} — было ${previousLate} вчера${value.lateOrdersDetail ? `. ${value.lateOrdersDetail}` : ""}`,
      });
    }

    const previousGoods = state.baseline?.finishedGoodsPieces;
    if (
      Number.isFinite(value.finishedGoodsPieces) && Number.isFinite(previousGoods) && previousGoods > 0
      && (previousGoods - value.finishedGoodsPieces) / previousGoods >= FINISHED_GOODS_DROP_RATIO
      && !alerted.metrics.includes("finishedGoods")
    ) {
      alerts.push({
        metric: "finishedGoods",
        title: "ERP: склад готовой продукции резко просел",
        body: `Осталось ${value.finishedGoodsPieces} шт — вчера было ${previousGoods}. Если это не крупная отгрузка, стоит посмотреть.`,
      });
    }

    for (const alert of alerts) {
      await push.sendInbox(owner.id, { id: `erp_anomaly_${today}_${alert.metric}`, kind: "erp-anomaly", title: alert.title, body: alert.body });
      alerted.metrics.push(alert.metric);
    }

    // The baseline moves once per local day, so "vs yesterday" stays literal:
    // comparing to a snapshot from twenty minutes ago would hide slow slides.
    const next = { ...state, alerted };
    if (state.baseline?.date !== today) {
      next.baseline = {
        date: today,
        lateOrders: Number.isFinite(value.lateOrders) ? value.lateOrders : state.baseline?.lateOrders,
        finishedGoodsPieces: Number.isFinite(value.finishedGoodsPieces) ? value.finishedGoodsPieces : state.baseline?.finishedGoodsPieces,
      };
    }
    if (alerts.length || next.baseline !== state.baseline) write(next);
    return alerts;
  }

  function start() {
    if (timer) return;
    const run = () => tick().catch((error) => console.warn(`[erp-anomalies] ${error.message}`)).finally(() => { timer = setTimeout(run, TICK_MS); });
    timer = setTimeout(run, TICK_MS);
  }

  return { tick, start, stop: () => { clearTimeout(timer); timer = null; } };
}

export const erpAnomalies = createErpAnomalies();
