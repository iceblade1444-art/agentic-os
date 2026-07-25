const OPEN_TASKS = new Set(["todo", "doing"]);

function localHour(timezone, now) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    return Number(parts.find((part) => part.type === "hour")?.value || 12);
  } catch {
    return now.getUTCHours();
  }
}

function greetingFor(hour) {
  if (hour < 6) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

export function personalBriefing(user, dashboard, onboardingState, approvals = [], now = new Date()) {
  const timezone = onboardingState.profile?.timezone || "Asia/Tashkent";
  const openTasks = (dashboard.tasks || []).filter((task) => OPEN_TASKS.has(task.status));
  const due = openTasks.filter((task) => task.dueDate && task.dueDate <= now.toISOString().slice(0, 10));
  const high = openTasks.filter((task) => task.priority === "high");
  const focus = due[0] || high[0] || openTasks[0] || null;
  const pressure = Math.min(100, openTasks.length * 12 + due.length * 18 + approvals.length * 10);
  const firstName = String(user.name || "пользователь").trim().split(/\s+/)[0];

  const summary = [];
  if (focus) summary.push(`Главный фокус: ${focus.title}.`);
  else summary.push("Срочных личных задач нет.");
  if (due.length) summary.push(`${due.length} задач требуют внимания сегодня.`);
  if (approvals.length) summary.push(`${approvals.length} действий агентов ожидают подтверждения.`);

  return {
    greeting: `${greetingFor(localHour(timezone, now))}, ${firstName}`,
    summary: summary.join(" "),
    focus,
    load: pressure,
    dueCount: due.length,
    approvalCount: approvals.length,
    timezone,
    generatedAt: now.toISOString(),
  };
}

