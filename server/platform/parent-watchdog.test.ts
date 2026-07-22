import assert from "node:assert/strict";
import test from "node:test";
import { parentProcessIsMissing, startParentWatchdog } from "./parent-watchdog";

test("parent watchdog is disabled without a valid Tauri parent PID", () => {
  assert.equal(parentProcessIsMissing(undefined), false);
  assert.equal(parentProcessIsMissing("not-a-pid"), false);
  assert.equal(startParentWatchdog(undefined, () => assert.fail("must stay disabled")), undefined);
});

test("parent watchdog only treats ESRCH as a missing parent", () => {
  const missingProbe = () => {
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  };
  const deniedProbe = () => {
    const error = new Error("denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  };

  assert.equal(parentProcessIsMissing("12345", missingProbe), true);
  assert.equal(parentProcessIsMissing("12345", deniedProbe), false);
  assert.equal(parentProcessIsMissing("12345", () => undefined), false);
});
