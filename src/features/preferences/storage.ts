const KEYS = {
  theme: "themisV2.preferences.theme",
  language: "themisV2.preferences.language",
  testsPath: "themisV2.workspace.testsPath",
  contestantsPath: "themisV2.workspace.contestantsPath",
  toolchainSetupCompleted: "themisV2.toolchainSetupCompleted",
  lastSeenVersion: "themisV2.lastSeenVersion",
} as const;

export type Theme = "light" | "dark";
export type Language = "en" | "vi";

function getLocalStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.error(`Failed to read ${key} from localStorage:`, error);
    return null;
  }
}

function setLocalStorageItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.error(`Failed to write ${key} to localStorage:`, error);
  }
}

export const preferencesStorage = {
  getTheme(): Theme | null {
    const val = getLocalStorageItem(KEYS.theme);
    if (val === "light" || val === "dark") {
      return val;
    }
    return null;
  },

  setTheme(theme: Theme): void {
    setLocalStorageItem(KEYS.theme, theme);
  },

  getLanguage(): Language | null {
    const val = getLocalStorageItem(KEYS.language);
    if (val === "en" || val === "vi") {
      return val;
    }
    return null;
  },

  setLanguage(lang: Language): void {
    setLocalStorageItem(KEYS.language, lang);
  },

  getTestsPath(): string | null {
    const val = getLocalStorageItem(KEYS.testsPath);
    return val && val.trim() !== "" ? val : null;
  },

  setTestsPath(path: string): void {
    setLocalStorageItem(KEYS.testsPath, path);
  },

  getContestantsPath(): string | null {
    const val = getLocalStorageItem(KEYS.contestantsPath);
    return val && val.trim() !== "" ? val : null;
  },

  setContestantsPath(path: string): void {
    setLocalStorageItem(KEYS.contestantsPath, path);
  },

  isToolchainSetupCompleted(): boolean {
    return getLocalStorageItem(KEYS.toolchainSetupCompleted) === "true";
  },

  setToolchainSetupCompleted(): void {
    setLocalStorageItem(KEYS.toolchainSetupCompleted, "true");
  },

  getLastSeenVersion(): string | null {
    const val = getLocalStorageItem(KEYS.lastSeenVersion);
    return val && val.trim() !== "" ? val : null;
  },

  setLastSeenVersion(version: string): void {
    setLocalStorageItem(KEYS.lastSeenVersion, version);
  },
};
