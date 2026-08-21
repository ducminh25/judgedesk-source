import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAppError, sanitizeErrorMessage } from "./app-error.js";

describe("app-error", () => {
  it("sanitizes Windows user paths and stack traces", () => {
    const raw = "Error: EPERM: operation not permitted, open 'C:\\Users\\admin\\AppData\\Local\\Temp\\test.txt'\n    at Object.openSync (node:fs:600:3)";
    const sanitized = sanitizeErrorMessage(raw);

    assert.equal(sanitized.includes("C:\\Users\\admin\\"), false);
    assert.equal(sanitized.includes("admin"), false);
    assert.equal(sanitized.includes("at Object.openSync"), false);
    assert.match(sanitized, /EPERM/);
  });

  it("sanitizes Unix/macOS user paths", () => {
    const raw = "Error: ENOENT: no such file or directory, open '/Users/johndoe/Desktop/Contest/test.inp'";
    const sanitized = sanitizeErrorMessage(raw);

    assert.equal(sanitized.includes("/Users/johndoe/"), false);
    assert.equal(sanitized.includes("johndoe"), false);
    assert.match(sanitized, /ENOENT/);
  });

  it("formats 3-part structured error for missing contestants folder", () => {
    const error = formatAppError("Please enter the path to the contestants folder.");

    assert.equal(typeof error.title, "string");
    assert.equal(typeof error.reason, "string");
    assert.equal(typeof error.action, "string");
    assert.match(error.title, /Thí sinh|Contestant/i);
    assert.match(error.action, /F3/);
  });

  it("formats 3-part structured error for backend connection failure", () => {
    const error = formatAppError(new Error("Failed to fetch"));

    assert.match(error.title, /kết nối|connect/i);
    assert.match(error.reason, /Backend|Dịch vụ/i);
    assert.match(error.action, /khởi động lại|restart/i);
  });

  it("formats 3-part structured error for file locked / Excel error", () => {
    const error = formatAppError("EBUSY: resource busy or locked, open 'Book.xlsx'");

    assert.match(error.title, /khóa|locked/i);
    assert.match(error.action, /đóng|close/i);
  });

  it("respects custom options and action callbacks", () => {
    let clicked = false;
    const error = formatAppError("Custom failure", {
      title: "Custom Title",
      reason: "Custom Reason",
      action: "Custom Action",
      actionLabel: "Fix Now",
      onAction: () => { clicked = true; },
      severity: "warning",
    });

    assert.equal(error.title, "Custom Title");
    assert.equal(error.reason, "Custom Reason");
    assert.equal(error.action, "Custom Action");
    assert.equal(error.actionLabel, "Fix Now");
    assert.equal(error.severity, "warning");

    error.onAction?.();
    assert.equal(clicked, true);
  });
});
