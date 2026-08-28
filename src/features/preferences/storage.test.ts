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

  it("should persist the last seen version", () => {
    assert.strictEqual(preferencesStorage.getLastSeenVersion(), null);
    preferencesStorage.setLastSeenVersion("1.3.7");
    assert.strictEqual(preferencesStorage.getLastSeenVersion(), "1.3.7");
  });

  it("should persist the Themis prompt choice", () => {
    assert.strictEqual(preferencesStorage.hasThemisPromptChoice(), false);
    assert.strictEqual(preferencesStorage.getThemisPromptChoice(), null);

    preferencesStorage.setThemisPromptChoice("themis");
    assert.strictEqual(preferencesStorage.hasThemisPromptChoice(), true);
    assert.strictEqual(preferencesStorage.getThemisPromptChoice(), "themis");

    preferencesStorage.setThemisPromptChoice("managed");
    assert.strictEqual(preferencesStorage.getThemisPromptChoice(), "managed");

    preferencesStorage.setThemisPromptChoice("dismissed");
    assert.strictEqual(preferencesStorage.getThemisPromptChoice(), "dismissed");
  });

  it("should persist the Scratch prompt choice", () => {
    assert.strictEqual(preferencesStorage.hasScratchPromptChoice(), false);
    assert.strictEqual(preferencesStorage.getScratchPromptChoice(), null);

    preferencesStorage.setScratchPromptChoice("enabled");
    assert.strictEqual(preferencesStorage.hasScratchPromptChoice(), true);
    assert.strictEqual(preferencesStorage.getScratchPromptChoice(), "enabled");

    preferencesStorage.setScratchPromptChoice("dismissed");
    assert.strictEqual(preferencesStorage.getScratchPromptChoice(), "dismissed");
  });

  it("should handle localStorage throwing errors gracefully", (context) => {
    const originalGet = (global as any).localStorage.getItem;
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => loggedErrors.push(args);
    (global as any).localStorage.getItem = () => {
      throw new Error("Security Error");
    };
    context.after(() => {
      (global as any).localStorage.getItem = originalGet;
      console.error = originalConsoleError;
    });

    // Should not throw, should return null
    assert.strictEqual(preferencesStorage.getTheme(), null);
    assert.strictEqual(loggedErrors.length, 1);
    assert.match(String(loggedErrors[0][0]), /Failed to read/);
  });
});
