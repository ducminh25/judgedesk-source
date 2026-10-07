import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextConfigTab, problemIoMode, problemScoreSummary } from "./modal-navigation.js";

describe("problem config navigation and summary", () => {
  it("wraps horizontal arrows and jumps to boundaries without consuming other keys", () => {
    assert.equal(nextConfigTab("basic", "ArrowLeft"), "compile");
    assert.equal(nextConfigTab("compile", "ArrowRight"), "basic");
    assert.equal(nextConfigTab("tests", "Home"), "basic");
    assert.equal(nextConfigTab("basic", "End"), "compile");
    assert.equal(nextConfigTab("compile", "Tab"), null);
    assert.equal(nextConfigTab("tests", "ArrowDown"), null);
  });
  it("preserves explicit zero and rational score while matching save fallback", () => {
    assert.equal(problemScoreSummary(0, "5"), "0");
    assert.equal(problemScoreSummary("100/3", "5"), "100/3");
    assert.equal(problemScoreSummary(null, "5/3"), "5/3");
    assert.equal(problemScoreSummary("  ", "5/3"), "5/3");
    assert.equal(problemScoreSummary("0", "5"), "0");
  });
  it("distinguishes all mixed and interactive modes", () => {
    assert.equal(problemIoMode(false, true, true), "standard");
    assert.equal(problemIoMode(false, false, false), "file");
    assert.equal(problemIoMode(false, true, false), "stdinFile");
    assert.equal(problemIoMode(false, false, true), "fileStdout");
    assert.equal(problemIoMode(true, false, false), "interactive");
  });
});
