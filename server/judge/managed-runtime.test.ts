import assert from "node:assert/strict";
import test from "node:test";
import { buildJavaRuntimeArgs } from "./managed-runtime.js";

test("Java runtime launch is deterministic and receives an explicit memory envelope", () => {
  const args = buildJavaRuntimeArgs(
    "/executor/workspaces/run/program",
    "Main",
    256 * 1024 * 1024,
  );
  assert.ok(args.includes("-XX:+UseSerialGC"));
  assert.ok(args.includes("-XX:ActiveProcessorCount=1"));
  assert.ok(args.includes(`-XX:MaxRAM=${256 * 1024 * 1024}`));
  assert.deepEqual(args.slice(-3), [
    "-cp",
    "/executor/workspaces/run/program",
    "Main",
  ]);
});
