import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { preferencesStorage } from "./storage.js";

// Mock localStorage for Node.js
let mockStorage: Record<string, string> = {};

(global as any).localStorage = {
  getItem: (key: string) => mockStorage[key] ?? null,
  setItem: (key: string, value: string) => {
    mockStorage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete mockStorage[key];
  },
  clear: () => {
    mockStorage = {};
  },
};

describe("preferencesStorage", () => {
  beforeEach(() => {
    (global as any).localStorage.clear();
  });

  it("should return null for unset theme", () => {
    assert.strictEqual(preferencesStorage.getTheme(), null);
  });

  it("should return null for invalid theme", () => {
    (global as any).localStorage.setItem(
      "themisV2.preferences.theme",
      "invalid",
    );
    assert.strictEqual(preferencesStorage.getTheme(), null);
  });

  it("should return correctly set theme", () => {
    preferencesStorage.setTheme("dark");
    assert.strictEqual(preferencesStorage.getTheme(), "dark");
  });

  it("should return null for invalid language", () => {
    (global as any).localStorage.setItem("themisV2.preferences.language", "fr");
    assert.strictEqual(preferencesStorage.getLanguage(), null);
  });

  it("should return correctly set language", () => {
    preferencesStorage.setLanguage("vi");
    assert.strictEqual(preferencesStorage.getLanguage(), "vi");
  });

  it("should return null for empty paths", () => {
    (global as any).localStorage.setItem("themisV2.workspace.testsPath", "  ");
    assert.strictEqual(preferencesStorage.getTestsPath(), null);
  });

  it("should return set paths", () => {
    preferencesStorage.setTestsPath("/path/to/tests");
    assert.strictEqual(preferencesStorage.getTestsPath(), "/path/to/tests");
    preferencesStorage.setContestantsPath("/path/to/contestants");
    assert.strictEqual(
      preferencesStorage.getContestantsPath(),
      "/path/to/contestants",
    );
  });

  it("should persist the toolchain first-run completion flag", () => {
    assert.strictEqual(preferencesStorage.isToolchainSetupCompleted(), false);
    preferencesStorage.setToolchainSetupCompleted();
    assert.strictEqual(preferencesStorage.isToolchainSetupCompleted(), true);
  });

  it("should handle localStorage throwing errors gracefully", () => {
    const originalGet = (global as any).localStorage.getItem;
    (global as any).localStorage.getItem = () => {
      throw new Error("Security Error");
    };

    // Should not throw, should return null
    assert.strictEqual(preferencesStorage.getTheme(), null);

    (global as any).localStorage.getItem = originalGet;
  });
});
