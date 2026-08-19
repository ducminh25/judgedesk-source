import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatShortcut,
  isMacOS,
  isTextInputTarget,
  matchShortcut,
  type ShortcutAction,
} from "./shortcuts.js";

describe("shortcuts module", () => {
  describe("platform detection", () => {
    it("recognizes darwin platform as Mac", () => {
      assert.equal(isMacOS("darwin"), true);
      assert.equal(isMacOS("win32"), false);
      assert.equal(isMacOS("linux"), false);
    });
  });

  describe("function keys (both Windows and Mac)", () => {
    const fnKeyMappings: Array<[string, ShortcutAction]> = [
      ["F1", "help"],
      ["F2", "loadProblems"],
      ["F3", "loadContestants"],
      ["F5", "reload"],
      ["F6", "toolchains"],
      ["F9", "judge"],
      ["F12", "exportExcel"],
    ];

    for (const [key, action] of fnKeyMappings) {
      it(`matches ${key} to ${action} on Windows`, () => {
        assert.equal(matchShortcut({ key }, false), action);
      });

      it(`matches ${key} to ${action} on Mac`, () => {
        assert.equal(matchShortcut({ key }, true), action);
      });
    }

    it("matches Escape to escape action", () => {
      assert.equal(matchShortcut({ key: "Escape" }, false), "escape");
      assert.equal(matchShortcut({ key: "Escape" }, true), "escape");
    });
  });

  describe("Windows shortcuts (ctrlKey)", () => {
    it("matches contest file operations", () => {
      assert.equal(matchShortcut({ key: "n", ctrlKey: true }, false), "newContest");
      assert.equal(matchShortcut({ key: "o", ctrlKey: true }, false), "openContest");
      assert.equal(matchShortcut({ key: "s", ctrlKey: true }, false), "saveContest");
      assert.equal(matchShortcut({ key: "s", ctrlKey: true, shiftKey: true }, false), "saveContestAs");
      assert.equal(matchShortcut({ key: "S", ctrlKey: true, shiftKey: true }, false), "saveContestAs");
    });

    it("matches contestant selections", () => {
      assert.equal(matchShortcut({ key: "a", ctrlKey: true }, false), "selectAllContestants");
      assert.equal(matchShortcut({ key: "d", ctrlKey: true }, false), "deselectAllContestants");
      assert.equal(matchShortcut({ key: "i", ctrlKey: true }, false), "toggleActiveContestant");
    });

    it("matches problem selections", () => {
      assert.equal(matchShortcut({ key: "a", ctrlKey: true, shiftKey: true }, false), "selectAllProblems");
      assert.equal(matchShortcut({ key: "d", ctrlKey: true, shiftKey: true }, false), "deselectAllProblems");
      assert.equal(matchShortcut({ key: "i", ctrlKey: true, shiftKey: true }, false), "toggleActiveProblem");
    });

    it("ignores metaKey on Windows", () => {
      assert.equal(matchShortcut({ key: "n", metaKey: true }, false), null);
    });
  });

  describe("macOS shortcuts (metaKey)", () => {
    it("matches contest file operations", () => {
      assert.equal(matchShortcut({ key: "n", metaKey: true }, true), "newContest");
      assert.equal(matchShortcut({ key: "o", metaKey: true }, true), "openContest");
      assert.equal(matchShortcut({ key: "s", metaKey: true }, true), "saveContest");
      assert.equal(matchShortcut({ key: "s", metaKey: true, shiftKey: true }, true), "saveContestAs");
    });

    it("matches contestant selections", () => {
      assert.equal(matchShortcut({ key: "a", metaKey: true }, true), "selectAllContestants");
      assert.equal(matchShortcut({ key: "d", metaKey: true }, true), "deselectAllContestants");
      assert.equal(matchShortcut({ key: "i", metaKey: true }, true), "toggleActiveContestant");
    });

    it("matches problem selections", () => {
      assert.equal(matchShortcut({ key: "a", metaKey: true, shiftKey: true }, true), "selectAllProblems");
      assert.equal(matchShortcut({ key: "d", metaKey: true, shiftKey: true }, true), "deselectAllProblems");
      assert.equal(matchShortcut({ key: "i", metaKey: true, shiftKey: true }, true), "toggleActiveProblem");
    });

    it("ignores ctrlKey for letters on Mac", () => {
      assert.equal(matchShortcut({ key: "n", ctrlKey: true }, true), null);
    });
  });

  describe("formatShortcut", () => {
    it("formats Windows labels", () => {
      assert.equal(formatShortcut("newContest", false), "Ctrl+N");
      assert.equal(formatShortcut("saveContestAs", false), "Ctrl+Shift+S");
      assert.equal(formatShortcut("selectAllContestants", false), "Ctrl+A");
      assert.equal(formatShortcut("toggleActiveContestant", false), "Ctrl+I");
      assert.equal(formatShortcut("selectAllProblems", false), "Ctrl+Shift+A");
      assert.equal(formatShortcut("judge", false), "F9");
      assert.equal(formatShortcut("escape", false), "Esc");
    });

    it("formats macOS labels", () => {
      assert.equal(formatShortcut("newContest", true), "⌘N");
      assert.equal(formatShortcut("saveContestAs", true), "⇧⌘S");
      assert.equal(formatShortcut("selectAllContestants", true), "⌘A");
      assert.equal(formatShortcut("toggleActiveContestant", true), "⌘I");
      assert.equal(formatShortcut("selectAllProblems", true), "⇧⌘A");
      assert.equal(formatShortcut("judge", true), "F9");
      assert.equal(formatShortcut("escape", true), "Esc");
    });
  });
});
