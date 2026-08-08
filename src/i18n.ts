import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { preferencesStorage } from "./features/preferences/storage";
import enTranslations from "./locales/en.json";
import viTranslations from "./locales/vi.json";
import enHelpTranslations from "./features/help/help.en.json";
import viHelpTranslations from "./features/help/help.vi.json";

const resources = {
  en: { translation: { ...enTranslations, helpCenter: enHelpTranslations } },
  vi: { translation: { ...viTranslations, helpCenter: viHelpTranslations } }
};

function resolveLanguage(): string {
  const persisted = preferencesStorage.getLanguage();
  if (persisted) return persisted;
  
  const browserLang = navigator.language || (navigator.languages && navigator.languages[0]);
  if (browserLang && browserLang.toLowerCase().startsWith("vi")) {
    return "vi";
  }
  return "en";
}

const initialLang = resolveLanguage();

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLang,
    fallbackLng: "en",
    interpolation: {
      escapeValue: false
    }
  });

i18n.on('languageChanged', (lng) => {
  if (lng === 'en' || lng === 'vi') {
    preferencesStorage.setLanguage(lng);
  }
  document.documentElement.lang = lng;
});

document.documentElement.lang = initialLang;

export default i18n;
