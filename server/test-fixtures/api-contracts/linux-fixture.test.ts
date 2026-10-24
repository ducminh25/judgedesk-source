import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { adaptLinuxFixture } from "./linux-fixture.js";

test("Linux fixture adaptation preserves readiness assertions and does not mutate canonical data", () => {
  const input = JSON.parse(fs.readFileSync(new URL("./get-toolchains.json", import.meta.url), "utf8"));
  const before = JSON.stringify(input);
  const output = adaptLinuxFixture("get-toolchains", input) as typeof input;
  assert.equal(JSON.stringify(input), before);
  assert.equal(output.platform, "linux");
  assert.equal(output.active.cpp.ready, true);
  assert.equal(output.active.cpp.executablePath.endsWith("gcc-linux-x64/bin/g++"), true);
  assert.equal(output.profiles.length, input.profiles.length);
  assert.deepEqual(output.profiles[0].roles, input.profiles[0].roles);
  assert.equal(output.profiles[0].certification.supported, false);
  assert.equal(output.profiles[0].localPolicy.executionMode, "quick_verified_direct");
});
