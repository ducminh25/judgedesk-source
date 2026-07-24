import assert from "node:assert/strict";
import test from "node:test";
import { parsePartialScore, trustedCheckerEnvironment } from "./custom-checker-runner";

test("partial checker scores accept multipliers and absolute points", () => {
  assert.equal(parsePartialScore("result = 0.25", "", 10), 0.25);
  assert.equal(parsePartialScore("points 2.5", "", 10), 0.25);
  assert.equal(parsePartialScore("", "details\n0.75\n", 10), 0.75);
});

test("partial checker scores reject missing and negative values", () => {
  assert.equal(parsePartialScore("no score", "", 10), null);
  assert.equal(parsePartialScore("result = -1", "", 10), null);
});

test("trusted Python checker environment excludes parent secrets and user-site packages", () => {
  const environment = trustedCheckerEnvironment(
    String.raw`C:\Python312\python.exe`,
    String.raw`C:\Temp\JudgeDesk`,
    "win32",
  );
  assert.equal(environment.PYTHONNOUSERSITE, "1");
  assert.equal(environment.PYTHONDONTWRITEBYTECODE, "1");
  assert.match(environment.Path || "", /^C:\\Python312;/);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.HOME, undefined);
});
