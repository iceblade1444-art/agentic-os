import { api } from "./api.js";
import { setLocale } from "./i18n.js";
import { milaHub } from "./mila-session.js";

export async function saveProfileLocale(locale) {
  const current = await api.onboarding.get();
  const result = await api.onboarding.save({
    profile: {
      ...current.profile,
      locale,
    },
    ...(current.canEditWorkspace ? { workspace: current.workspace } : {}),
  });
  const savedLocale = setLocale(result.profile?.locale || locale);
  milaHub.setLanguage(savedLocale);
  return result;
}
