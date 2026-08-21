// The company half of the morning brief — for operators.
//
// The personal plan answers "what is my day"; on a quiet day that is honestly
// two lines, which is the wrong size for someone running three factories. This
// module adds what the company did while the owner slept: yesterday's sewing
// output with its day-over-day direction, the warehouse and late orders, new
// leads, what waits in the team chat, and what the system recorded yesterday.
//
// Every block follows the house rules: a number that could not be read is
// absent or "нет данных" — never zero; an empty block is not printed at all,
// so the brief does not bloat on a quiet day; and these blocks ride only in
// the personal delivery, never in a channel copy of the brief.

import { journal } from "./journal.js";
import { mfa } from "./mfa.js";
import { messenger } from "./messenger.js";
import { attendanceFacts, processFacts, sewingFacts } from "./mila-actions.js";
import { erpBridge } from "./erp-bridge.js";
import { erpDigest } from "./erp-digest.js";
import { salesBot } from "./sales-bot.js";

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

function localDay(date, timeZone) {
  return date.toLocaleDateString("sv-SE", { timeZone });
}

function delta(current, previous, { downIsGood = false } = {}) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "";
  const diff = current - previous;
  if (!diff) return "";
  const arrow = diff > 0 ? "▲" : "▼";
  void downIsGood;
  return ` (${arrow} ${Math.abs(diff)})`;
}

export function createCompanyBrief(options = {}) {
  const bridge = options.erpBridge || erpBridge;
  const digest = options.erpDigest || erpDigest;
  const sales = options.salesBot || salesBot;
  const chatStore = options.messenger || messenger;
  const journalStore = options.journal || journal;
  const mfaStore = options.mfa || mfa;
  const now = options.now || (() => new Date());

  async function production(timeZone) {
    const lines = [];
    const yesterday = localDay(new Date(now().getTime() - 24 * 3600 * 1000), timeZone);
    const dayBefore = localDay(new Date(now().getTime() - 48 * 3600 * 1000), timeZone);
    try {
      const [current, previous] = await Promise.all([
        bridge.call("erp_sewing_daily_report", { report_date: yesterday, factory_code: "MIL" }),
        bridge.call("erp_sewing_daily_report", { report_date: dayBefore, factory_code: "MIL" }).catch(() => null),
      ]);
      if (current?.ok !== false) {
        const facts = sewingFacts(current?.data || {});
        const rawBefore = previous && previous.ok !== false ? sewingFacts(previous?.data || {}) : null;
        // No report the day before — a Sunday, a holiday — is not a zero to
        // beat: "▲ 6981 к выходному" congratulates the factory for existing.
        const before = rawBefore && rawBefore.lines_reported > 0 ? rawBefore : null;
        if (Number.isFinite(facts.total_sewn) && facts.lines_reported > 0) {
          lines.push(`Швейка вчера: ${facts.total_sewn} шт по ${facts.lines_reported} линиям${delta(facts.total_sewn, before?.total_sewn)}${facts.total_defective ? `, брак ${facts.total_defective}` : ""}`);
        }
      }
    } catch { /* ERP quiet — the block just loses this line */ }

    // The process board answers the question the sewing total cannot: whether
    // the orders themselves are on time. An overdue order that has produced
    // nothing is called out separately — that is the one needing a decision
    // today, not a nudge.
    try {
      const board = await bridge.call("erp_process_tracking", {});
      if (board?.ok !== false) {
        const facts = processFacts(board?.data || {});
        if (facts.total_in_work > 0) {
          const stages = Object.entries(facts.by_stage).map(([stage, count]) => `${stage} ${count}`).join(", ");
          lines.push(`Заказы в производстве: ${facts.total_in_work}${stages ? ` — ${stages}` : ""}`);
          if (facts.overdue) {
            lines.push(`За сроком: ${facts.overdue}${facts.overdue_not_started ? `, из них ${facts.overdue_not_started} ещё не начаты` : ""}`);
            // A count cannot be acted on; a name can. The untouched ones are
            // named because those are the orders somebody has to move today.
            const stalled = (facts.orders || [])
              .filter((order) => order.overdue && !order.done)
              .slice(0, 4)
              .map((order) => `${order.order}${order.deadline ? ` (срок ${order.deadline})` : ""}`);
            if (stalled.length) lines.push(`Не начаты: ${stalled.join(", ")}`);
          }
        }
      }
    } catch { /* the board is quiet — the block just loses these lines */ }

    try {
      const gate = await bridge.call("erp_attendance_overview", {});
      if (gate?.ok !== false) {
        const facts = attendanceFacts(gate?.data || {});
        if (Number.isFinite(facts.present) && Number.isFinite(facts.total)) {
          const at = now().toLocaleTimeString("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" });
          lines.push(`Явка на ${at}: ${facts.present} из ${facts.total}`);
        }
      }
    } catch { /* the turnstile is quiet — the block just loses this line */ }

    try {
      const value = await digest.read();
      if (value.available) {
        if (Number.isFinite(value.lateOrders)) {
          lines.push(`Просрочки по клиентским заказам: ${value.lateOrders}${value.lateOrders && value.lateOrdersDetail ? ` — ${value.lateOrdersDetail}` : ""}`);
        }
        if (Number.isFinite(value.finishedGoodsPieces)) lines.push(`Склад готовой продукции: ${value.finishedGoodsPieces} шт`);
        if (value.financeFlag) lines.push(`Финансы: ${clean(value.financeFlag, 120)}`);
      }
    } catch { /* same rule */ }
    return lines.length ? `Производство:\n${lines.map((line) => `• ${line}`).join("\n")}` : "";
  }

  function customers(timeZone) {
    if (!sales.configured()) return "";
    const yesterday = localDay(new Date(now().getTime() - 24 * 3600 * 1000), timeZone);
    const leads = sales.leads({ limit: 200 });
    const fresh = leads.filter((lead) => String(lead.createdAt || "").startsWith(yesterday)).length;
    const open = leads.filter((lead) => lead.status === "new").length;
    if (!fresh && !open) return "";
    return `Клиенты:\n• Новых лидов за вчера: ${fresh}\n• Ждут ответа менеджера: ${open}`;
  }

  function team(user) {
    const conversations = chatStore.listFor(user.id);
    const unread = conversations.reduce((total, item) => total + (item.unread || 0), 0);
    if (!unread) return "";
    const mentioned = conversations.filter((item) => item.mentioned);
    const busiest = conversations
      .filter((item) => item.unread > 0)
      .sort((a, b) => b.unread - a.unread)
      .slice(0, 3)
      .map((item) => `${item.kind === "channel" ? "#" : ""}${clean(item.name, 40)} (${item.unread})`);
    const lines = [`Непрочитанных: ${unread} — ${busiest.join(", ")}`];
    if (mentioned.length) lines.push(`Вас упомянули: ${mentioned.map((item) => `${item.kind === "channel" ? "#" : ""}${clean(item.name, 40)}`).join(", ")}`);
    return `Команда:\n${lines.map((line) => `• ${line}`).join("\n")}`;
  }

  function yesterdayInSystem(timeZone) {
    const yesterday = localDay(new Date(now().getTime() - 24 * 3600 * 1000), timeZone);
    let entries = [];
    try {
      entries = journalStore.recentEntries({ days: 2, limit: 40, timeZone })
        .filter((entry) => entry.date === yesterday);
    } catch {
      return "";
    }
    if (!entries.length) return "";
    const shown = entries.slice(0, 4).map((entry) => `• ${clean(entry.title, 90)}`);
    const more = entries.length > shown.length ? `\n• …и ещё ${entries.length - shown.length}` : "";
    return `Вчера в системе:\n${shown.join("\n")}${more}`;
  }

  // The operator's company morning, as appendable text blocks. Members get an
  // empty string: their brief stays their own plan.
  // An account with full rights and no second factor is one phished password
  // away from the whole company. This says so once a morning and stops the day
  // it is switched on — a nudge that ends by itself, not a permanent banner.
  function security(user) {
    try {
      const status = mfaStore.status(user);
      if (!status.eligible || status.enabled) return "";
      return ["Безопасность:", "• Двухфакторная защита выключена — включите в Настройках, у вас полные права"].join("\n");
    } catch {
      return "";
    }
  }

  async function blocks(user, timeZone = "Asia/Tashkent") {
    if (!["Creator", "Admin", "CEO"].includes(user?.role)) return "";
    const parts = [
      await production(timeZone),
      customers(timeZone),
      team(user),
      yesterdayInSystem(timeZone),
      security(user),
    ].filter(Boolean);
    return parts.length ? `\n\n${parts.join("\n\n")}` : "";
  }

  return { blocks };
}

export const companyBrief = createCompanyBrief();
