import assert from "node:assert/strict";
import test from "node:test";
import { managedCacheId } from "./toolchain-cache-id.js";
test("Linux cache IDs separate content while Windows and macOS preserve their paths", () => {
  const a = "a".repeat(64), b = "b".repeat(64);
  assert.notEqual(managedCacheId("linux", "gcc-linux-x64", "14.2.0", a), managedCacheId("linux", "gcc-linux-x64", "14.2.0", b));
  assert.equal(managedCacheId("linux", "jdk", "21+8", a), "jdk_21_8_" + a);
  assert.throws(() => managedCacheId("linux", "gcc", "1"), /digest/);
  assert.throws(() => managedCacheId("linux", "gcc", "1", "../escape"), /digest/);
  for (const host of ["win32", "darwin"]) assert.equal(managedCacheId(host, "jdk", "21+8", a), "jdk_21_8");
});
