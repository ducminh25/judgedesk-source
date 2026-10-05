import assert from "node:assert/strict";
import test from "node:test";
import { nativeCompilerKindsToPrewarm } from "./background-prewarm.js";

test("C-only judge requirements select managed-C prewarming", () => {
  assert.deepEqual(
    nativeCompilerKindsToPrewarm(new Set(["c"])),
    ["c"],
  );
});

test("C++ and C requirements preserve deterministic prewarm order", () => {
  assert.deepEqual(
    nativeCompilerKindsToPrewarm(new Set(["c", "cpp"])),
    ["cpp", "c"],
  );
});
