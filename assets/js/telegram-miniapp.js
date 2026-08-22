// The console, behaving like a Telegram app when it is running inside one.
//
// The SPA already worked in Telegram — `?start=<route>` has opened it since the
// bot links existed — but it worked the way any web page opens in any browser:
// its own back button, its own colours, and a 100vh that Telegram's container
// does not agree with. This is the difference between a page Telegram can show
// and a Mini App.
//
// Everything is a no-op outside Telegram. `window.Telegram.WebApp` exists only
// where the container injected it, so the ordinary web app loads this module
// and nothing happens.

const webApp = () => globalThis.Telegram?.WebApp || null;

export const inTelegram = () => Boolean(webApp()?.initData);

/**
 * Trade Telegram's signed initData for an ordinary session.
 *
 * Runs before the app decides whether it needs a login screen. A failure is
 * not fatal: the normal sign-in form is a perfectly good fallback, and saying
 * so beats a blank frame.
 */
export async function authenticate() {
  const app = webApp();
  if (!app?.initData) return null;
  try {
    const response = await fetch("/api/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: app.initData }),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok ? data : { error: data.error || `HTTP ${response.status}`, code: data.code };
  } catch (error) {
    return { error: error.message };
  }
}

/* ---------------- theme ----------------
   Telegram hands the page the colours the reader chose for their client, and
   using them is what stops a Mini App looking like a website somebody embedded.

   The grounds and the text colours are taken. The accent is not, and neither
   are the semantics. Two reasons, both about contrast:

   - --primary is load-bearing here in a way Telegram's button_color is not. It
     is a fill, a focus ring, an active rail item and a border. Telegram
     guarantees button_color works with button_text_color and nothing else;
     the default blue is 2.4:1 against white, so adopting it would undo the
     contrast work everywhere it is used without a paired ink.
   - green-means-good is ours, not the client's, and a palette that knows
     nothing about our states cannot be trusted to colour them. */
const THEME_MAP = [
  ["bg_color", "--bg"],
  ["secondary_bg_color", "--surface"],
  ["section_bg_color", "--surface-2"],
  ["text_color", "--text"],
  ["hint_color", "--text-3"],
];

const isLightGround = (hex) => {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!match) return null;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255);
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) > 0.4;
};

export function applyTheme(app = webApp()) {
  if (!app) return 0;
  const params = app.themeParams || {};
  const root = document.documentElement;

  // Which token set to start from, decided by the ground we are actually
  // given rather than by colorScheme. Telegram themes are user-made: a theme
  // can call itself light and hand over a dark background, and starting from
  // the wrong set would put light-theme ink on it.
  const measured = isLightGround(params.bg_color);
  const light = measured === null ? app.colorScheme === "light" : measured;
  root.setAttribute("data-theme", light ? "light" : "dark");

  let applied = 0;
  for (const [from, token] of THEME_MAP) {
    const value = params[from];
    // Only a real colour. Telegram omits fields rather than sending blanks,
    // and a token set to "" takes the whole declaration down with it.
    if (!/^#[0-9a-f]{6}$/i.test(String(value || ""))) continue;
    root.style.setProperty(token, value);
    applied++;
  }
  return applied;
}

/* ---------------- viewport ----------------
   Telegram's container is not the browser viewport: it has a header, it can be
   collapsed, and it resizes as the keyboard opens. viewportStableHeight is the
   height that does not flicker while that happens. */
export function applyViewport(app = webApp()) {
  if (!app) return;
  const height = Number(app.viewportStableHeight || app.viewportHeight || 0);
  if (height > 0) document.documentElement.style.setProperty("--tg-viewport", `${Math.round(height)}px`);
}

/* ---------------- back button ----------------
   Telegram draws the back affordance in its own header. A Mini App that leaves
   it hidden strands the reader on any screen below the first. */
export function syncBackButton(app = webApp()) {
  if (!app?.BackButton) return;
  const atRoot = !location.hash || location.hash === "#/" || location.hash === "#";
  if (atRoot) app.BackButton.hide();
  else app.BackButton.show();
}

/* ---------------- main button ----------------
   The container's own primary button, at the bottom of the screen where the
   thumb is. Rather than retrofitting every page, it mirrors whatever the
   current view marks as its primary action:

     <button class="btn btn-primary" data-tg-main>Save</button>

   so a page opts in with one attribute and the button follows it. */
export function syncMainButton(app = webApp()) {
  if (!app?.MainButton) return null;
  const target = document.querySelector("[data-tg-main]");
  if (!target || target.disabled) { app.MainButton.hide(); return null; }
  app.MainButton.setText((target.dataset.tgMain || target.textContent || "").trim().slice(0, 64));
  app.MainButton.show();
  return target;
}

/**
 * Start the bridge. Safe to call anywhere; does nothing outside Telegram.
 *
 * Returns a teardown, which the app does not currently need — the Mini App
 * lives for one container session — but a module that installs listeners
 * should be able to remove them.
 */
export function mountTelegramBridge() {
  const app = webApp();
  if (!app) return () => {};

  app.ready();
  app.expand?.();
  applyTheme(app);
  applyViewport(app);
  syncBackButton(app);

  const onBack = () => history.back();
  app.BackButton?.onClick?.(onBack);

  let mainTarget = null;
  const onMain = () => mainTarget?.click();
  app.MainButton?.onClick?.(onMain);

  const refresh = () => {
    syncBackButton(app);
    // The view is replaced on every route change, so the button has to be
    // re-read rather than remembered.
    mainTarget = syncMainButton(app);
  };
  window.addEventListener("hashchange", refresh);
  app.onEvent?.("themeChanged", () => applyTheme(app));
  app.onEvent?.("viewportChanged", () => applyViewport(app));
  // A page can rebuild its own primary action without changing route.
  const observer = new MutationObserver(() => { mainTarget = syncMainButton(app); });
  const view = document.getElementById("view");
  if (view) observer.observe(view, { childList: true, subtree: true });
  refresh();

  return () => {
    window.removeEventListener("hashchange", refresh);
    observer.disconnect();
    app.BackButton?.offClick?.(onBack);
    app.MainButton?.offClick?.(onMain);
  };
}
