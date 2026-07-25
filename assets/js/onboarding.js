import { api } from "./api.js";
import { brandMark } from "./brand.js";
import { icon } from "./icons.js";
import { milaHub } from "./mila-session.js";
import { esc } from "./ui.js";

const COPY = {
  "ru-RU": {
    title: "Настроим рабочую среду", subtitle: "Эти данные станут общим контекстом для Hermes, MILA, Claude и агентов.",
    steps: ["Вы", "Компания", "Цели"], next: "Продолжить", back: "Назад", finish: "Сохранить и начать",
    fields: {
      language: "Язык интерфейса и ассистента", focus: "Ваша роль и зона ответственности", focusPlaceholder: "Владелец, продукт, продажи, операционная работа...",
      mila: "Как MILA должна работать с вами?", answers: "Голосовые ответы", brief: "Кратко, от одного до трёх предложений", balanced: "Сбалансированно, с коротким объяснением",
      name: "Название компании или рабочей среды *", industry: "Сфера деятельности", industryPlaceholder: "Розница, производство, технологии...",
      summary: "Чем занимается компания?", audience: "Клиенты и аудитория", products: "Продукты и услуги", languages: "Рабочие языки",
      goals: "Текущие цели", constraints: "Важные ограничения", onePerLine: "по одной строке",
      goalsPlaceholder: "Запустить продукт\nАвтоматизировать поддержку\nУвеличить продажи",
      constraintsPlaceholder: "Спрашивать перед внешними сообщениями\nНе передавать данные клиентов",
      result: "Что произойдёт после сохранения",
      resultText: "Agentic OS безопасно сохранит настройку и обновит контекст компании и пользователя в Obsidian. Агенты будут работать с реальными целями компании, а не с общими промптами.",
      nameError: "Укажите название компании или рабочей среды.", saveError: "Не удалось сохранить настройку.",
    },
  },
  "uz-UZ": {
    title: "Ish muhitini sozlaymiz", subtitle: "Bu ma'lumot Hermes, MILA, Claude va agentlar uchun umumiy kontekst bo'ladi.",
    steps: ["Siz", "Kompaniya", "Maqsadlar"], next: "Davom etish", back: "Orqaga", finish: "Saqlash va boshlash",
    fields: {
      language: "Interfeys va yordamchi tili", focus: "Sizning vazifangiz", focusPlaceholder: "Egasi, mahsulot, savdo, operatsiyalar...",
      mila: "MILA siz bilan qanday ishlashi kerak?", answers: "Ovozli javoblar", brief: "Qisqa, bir-uch jumla", balanced: "Muvozanatli, qisqa izoh bilan",
      name: "Kompaniya yoki ish muhiti nomi *", industry: "Faoliyat sohasi", industryPlaceholder: "Savdo, ishlab chiqarish, texnologiya...",
      summary: "Kompaniya nima bilan shug'ullanadi?", audience: "Mijozlar va auditoriya", products: "Mahsulot va xizmatlar", languages: "Ish tillari",
      goals: "Hozirgi maqsadlar", constraints: "Muhim cheklovlar", onePerLine: "har birini yangi qatorda",
      goalsPlaceholder: "Mahsulotni ishga tushirish\nYordamni avtomatlashtirish\nSavdoni oshirish",
      constraintsPlaceholder: "Tashqi xabarlardan oldin so'rash\nMijoz ma'lumotlarini himoya qilish",
      result: "Saqlangandan keyin nima bo'ladi",
      resultText: "Agentic OS sozlamani xavfsiz saqlaydi va Obsidian'dagi kompaniya hamda foydalanuvchi kontekstini yangilaydi. Agentlar umumiy promptlar emas, haqiqiy maqsadlar bilan ishlaydi.",
      nameError: "Kompaniya yoki ish muhiti nomini kiriting.", saveError: "Sozlamani saqlab bo'lmadi.",
    },
  },
  "en-US": {
    title: "Set up your workspace", subtitle: "This becomes shared context for Hermes, MILA, Claude and your agents.",
    steps: ["You", "Company", "Goals"], next: "Continue", back: "Back", finish: "Save and start",
    fields: {
      language: "Interface and assistant language", focus: "Your work focus", focusPlaceholder: "Owner, product, sales, operations...",
      mila: "How should MILA work with you?", answers: "Voice answers", brief: "Brief, one to three sentences", balanced: "Balanced, with a short explanation",
      name: "Workspace or company name *", industry: "Industry", industryPlaceholder: "Retail, manufacturing, technology...",
      summary: "What does the business do?", audience: "Customers and audience", products: "Products and services", languages: "Operating languages",
      goals: "Current goals", constraints: "Important constraints", onePerLine: "one per line",
      goalsPlaceholder: "Launch the product\nAutomate customer support\nIncrease sales",
      constraintsPlaceholder: "Ask before external messages\nKeep customer data private",
      result: "What happens after saving",
      resultText: "Agentic OS stores the setup securely and updates company and user context in Obsidian. Agents can then work from real company goals instead of generic prompts.",
      nameError: "Enter the workspace or company name.", saveError: "Could not save workspace setup.",
    },
  },
};

const STYLE_COPY = {
  "ru-RU": {
    assistant: ["Ассистент", "Спокойно и практично"], operator: ["Оператор", "Решительно и по задачам"],
    mentor: ["Наставник", "Объясняет следующий шаг"], friend: ["Собеседник", "Тепло и неформально"],
  },
  "uz-UZ": {
    assistant: ["Yordamchi", "Tinch va amaliy"], operator: ["Operator", "Aniq va vazifaga yo'naltirilgan"],
    mentor: ["Ustoz", "Keyingi qadamni tushuntiradi"], friend: ["Hamroh", "Iliq va norasmiy"],
  },
  "en-US": {
    assistant: ["Assistant", "Calm and practical"], operator: ["Operator", "Decisive and action-focused"],
    mentor: ["Mentor", "Explains the next step"], friend: ["Companion", "Warm and informal"],
  },
};

const lines = (value) => String(value || "").split("\n").map((item) => item.trim()).filter(Boolean);

export function renderOnboarding(initial) {
  const app = document.querySelector("#app");
  const profile = initial.profile || {};
  const workspace = initial.workspace || {};
  let step = 0;
  let locale = profile.locale || (navigator.language?.startsWith("uz") ? "uz-UZ" : navigator.language?.startsWith("en") ? "en-US" : "ru-RU");

  app.removeAttribute("aria-busy");
  app.innerHTML = `<main class="onboarding">
    <aside class="onboarding-rail">
      <div class="onboarding-brand"><span>${brandMark()}</span><strong>Mila</strong></div>
      <ol id="onboardingSteps"></ol>
      <div class="onboarding-context">${icon("knowledge")}<span>Obsidian<br/><small>Shared agent context</small></span></div>
    </aside>
    <section class="onboarding-main">
      <header><span class="badge neutral" id="onboardingCounter"></span><h1 id="onboardingTitle"></h1><p id="onboardingSubtitle"></p></header>
      <form id="onboardingForm">
        <div class="onboarding-page" data-step="0">
          <div class="field"><label class="label" id="obLanguageLabel">Interface and assistant language</label><select class="select" id="obLocale">
            <option value="ru-RU">Русский</option><option value="uz-UZ">O'zbekcha</option><option value="en-US">English</option>
          </select></div>
          <div class="field"><label class="label" id="obFocusLabel">Your work focus</label><input class="input" id="obRoleFocus" maxlength="160" value="${esc(profile.roleFocus || "")}" placeholder="Owner, product, sales, operations..."/></div>
          <div class="onboarding-choice">
            <span class="label" id="obMilaLabel">How should MILA work with you?</span>
            ${[["assistant", "Assistant", "Calm and practical"], ["operator", "Operator", "Decisive and action-focused"], ["mentor", "Mentor", "Explains the next step"], ["friend", "Companion", "Warm and informal"]].map(([value, title, detail]) =>
              `<label><input type="radio" name="obStyle" value="${value}" ${(profile.assistantStyle || "assistant") === value ? "checked" : ""}/><span>${icon(value === "operator" ? "activity" : value === "mentor" ? "book" : value === "friend" ? "chat" : "sparkles")}<strong data-style-title="${value}">${title}</strong><small data-style-detail="${value}">${detail}</small></span></label>`).join("")}
          </div>
          <div class="field"><label class="label" id="obAnswersLabel">Voice answers</label><select class="select" id="obLength"><option value="brief">Brief, one to three sentences</option><option value="balanced">Balanced, with a short explanation</option></select></div>
        </div>
        <div class="onboarding-page" data-step="1">
          <div class="onboarding-grid">
            <div class="field"><label class="label" id="obNameLabel">Workspace or company name *</label><input class="input" id="obName" maxlength="140" value="${esc(workspace.name || "")}" required/></div>
            <div class="field"><label class="label" id="obIndustryLabel">Industry</label><input class="input" id="obIndustry" maxlength="140" value="${esc(workspace.industry || "")}" placeholder="Retail, manufacturing, technology..."/></div>
          </div>
          <div class="field"><label class="label" id="obSummaryLabel">What does the business do?</label><textarea class="textarea" id="obSummary" rows="4" maxlength="1200">${esc(workspace.summary || "")}</textarea></div>
          <div class="field"><label class="label" id="obAudienceLabel">Customers and audience</label><textarea class="textarea" id="obAudience" rows="3" maxlength="600">${esc(workspace.audience || "")}</textarea></div>
          <div class="field"><label class="label" id="obProductsLabel">Products and services</label><textarea class="textarea" id="obProducts" rows="3" maxlength="1200">${esc(workspace.products || "")}</textarea></div>
          <fieldset class="onboarding-languages"><legend id="obLanguagesLabel">Operating languages</legend>
            ${["Russian", "Uzbek", "English"].map((language) => `<label><input type="checkbox" name="obLanguage" value="${language}" ${(workspace.operatingLanguages || ["Russian", "Uzbek"]).includes(language) ? "checked" : ""}/><span>${language}</span></label>`).join("")}
          </fieldset>
        </div>
        <div class="onboarding-page" data-step="2">
          <div class="field"><label class="label"><span id="obGoalsLabel">Current goals</span> <span class="muted" id="obGoalsHint">one per line</span></label><textarea class="textarea" id="obGoals" rows="7">${esc((workspace.goals || []).join("\n"))}</textarea></div>
          <div class="field"><label class="label"><span id="obConstraintsLabel">Important constraints</span> <span class="muted" id="obConstraintsHint">one per line</span></label><textarea class="textarea" id="obConstraints" rows="5">${esc((workspace.constraints || []).join("\n"))}</textarea></div>
          <div class="onboarding-result">${icon("check")}<div><strong id="obResultTitle">What happens after saving</strong><p id="obResultText"></p></div></div>
        </div>
        <div class="field-error hidden" id="onboardingError"></div>
        <footer><button class="btn btn-secondary" id="obBack" type="button"></button><div class="spacer"></div><button class="btn btn-primary" id="obNext" type="button"><span></span>${icon("arrowright")}</button></footer>
      </form>
    </section>
  </main>`;

  const form = app.querySelector("#onboardingForm");
  const localeSelect = app.querySelector("#obLocale");
  localeSelect.value = locale;
  app.querySelector("#obLength").value = profile.responseLength || "brief";
  localeSelect.onchange = () => { locale = localeSelect.value; draw(); };

  const draw = () => {
    const copy = COPY[locale];
    const fields = copy.fields;
    app.querySelector("#onboardingTitle").textContent = copy.title;
    app.querySelector("#onboardingSubtitle").textContent = copy.subtitle;
    app.querySelector("#onboardingCounter").textContent = `${step + 1} / 3`;
    app.querySelector("#onboardingSteps").innerHTML = copy.steps.map((label, index) =>
      `<li class="${index === step ? "active" : index < step ? "done" : ""}"><span>${index < step ? icon("check") : index + 1}</span><strong>${label}</strong></li>`).join("");
    form.querySelectorAll(".onboarding-page").forEach((page) => page.classList.toggle("active", Number(page.dataset.step) === step));
    const back = app.querySelector("#obBack");
    back.textContent = copy.back;
    back.classList.toggle("hidden", step === 0);
    app.querySelector("#obNext span").textContent = step === 2 ? copy.finish : copy.next;
    app.querySelector("#obLanguageLabel").textContent = fields.language;
    app.querySelector("#obFocusLabel").textContent = fields.focus;
    app.querySelector("#obRoleFocus").placeholder = fields.focusPlaceholder;
    app.querySelector("#obMilaLabel").textContent = fields.mila;
    app.querySelector("#obAnswersLabel").textContent = fields.answers;
    app.querySelector('#obLength option[value="brief"]').textContent = fields.brief;
    app.querySelector('#obLength option[value="balanced"]').textContent = fields.balanced;
    for (const [style, labels] of Object.entries(STYLE_COPY[locale])) {
      app.querySelector(`[data-style-title="${style}"]`).textContent = labels[0];
      app.querySelector(`[data-style-detail="${style}"]`).textContent = labels[1];
    }
    app.querySelector("#obNameLabel").textContent = fields.name;
    app.querySelector("#obIndustryLabel").textContent = fields.industry;
    app.querySelector("#obIndustry").placeholder = fields.industryPlaceholder;
    app.querySelector("#obSummaryLabel").textContent = fields.summary;
    app.querySelector("#obAudienceLabel").textContent = fields.audience;
    app.querySelector("#obProductsLabel").textContent = fields.products;
    app.querySelector("#obLanguagesLabel").textContent = fields.languages;
    app.querySelector("#obGoalsLabel").textContent = fields.goals;
    app.querySelector("#obGoalsHint").textContent = fields.onePerLine;
    app.querySelector("#obGoals").placeholder = fields.goalsPlaceholder;
    app.querySelector("#obConstraintsLabel").textContent = fields.constraints;
    app.querySelector("#obConstraintsHint").textContent = fields.onePerLine;
    app.querySelector("#obConstraints").placeholder = fields.constraintsPlaceholder;
    app.querySelector("#obResultTitle").textContent = fields.result;
    app.querySelector("#obResultText").textContent = fields.resultText;
  };

  app.querySelector("#obBack").onclick = () => { step = Math.max(0, step - 1); draw(); };
  app.querySelector("#obNext").onclick = async () => {
    const error = app.querySelector("#onboardingError");
    error.classList.add("hidden");
    if (step === 1 && app.querySelector("#obName").value.trim().length < 2) {
      error.textContent = COPY[locale].fields.nameError;
      error.classList.remove("hidden");
      app.querySelector("#obName").focus();
      return;
    }
    if (step < 2) { step += 1; draw(); return; }
    const button = app.querySelector("#obNext");
    button.classList.add("loading");
    try {
      const result = await api.onboarding.save({
        profile: {
          locale,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tashkent",
          roleFocus: app.querySelector("#obRoleFocus").value,
          assistantStyle: form.querySelector('input[name="obStyle"]:checked')?.value,
          responseLength: app.querySelector("#obLength").value,
        },
        workspace: {
          name: app.querySelector("#obName").value,
          industry: app.querySelector("#obIndustry").value,
          summary: app.querySelector("#obSummary").value,
          audience: app.querySelector("#obAudience").value,
          products: app.querySelector("#obProducts").value,
          goals: lines(app.querySelector("#obGoals").value),
          constraints: lines(app.querySelector("#obConstraints").value),
          operatingLanguages: [...form.querySelectorAll('input[name="obLanguage"]:checked')].map((input) => input.value),
        },
      });
      milaHub.setLanguage(result.profile.locale);
      milaHub.setPreferences({
        ...milaHub.state.preferences,
        style: result.profile.assistantStyle,
        responseLength: result.profile.responseLength,
        userName: api.auth.user?.name || milaHub.state.preferences.userName,
      });
      history.replaceState(null, "", location.pathname + location.hash);
      location.reload();
    } catch (saveError) {
      error.textContent = saveError.message || COPY[locale].fields.saveError;
      error.classList.remove("hidden");
      button.classList.remove("loading");
    }
  };
  draw();
}
