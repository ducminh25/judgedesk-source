import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { preferencesStorage } from "./features/preferences/storage";
import enTranslations from "./locales/en.json";
import viTranslations from "./locales/vi.json";

const resources = {
  en: { translation: enTranslations },
  vi: { translation: viTranslations }
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
