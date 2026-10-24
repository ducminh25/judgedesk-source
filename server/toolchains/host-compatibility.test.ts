import assert from "node:assert/strict";
import test from "node:test";
import { getHostProductVersion, isManagedHostSupported, isMinimumOsSupported, resetHostProductVersionCacheForTests } from "./host-compatibility.js";

test("minimum OS checks compare numeric product versions and fail closed", () => {
  assert.equal(isMinimumOsSupported("13.5", "13.5"), true);
  assert.equal(isMinimumOsSupported("13.5", "14.0"), true);
  assert.equal(isMinimumOsSupported("14.0", "13.6.9"), false);
  assert.equal(isMinimumOsSupported("10.0", "10.0.26100"), true);
  assert.equal(isMinimumOsSupported("14.0", "unknown"), false);
});

test("Linux package admission compares the pinned libc baseline, not distro or kernel versions", () => {
  assert.equal(isManagedHostSupported("linux", "22.04", "2.35"), true);
  assert.equal(isManagedHostSupported("linux", "22.04", "2.42"), true);
  assert.equal(isManagedHostSupported("linux", "22.04", "2.34"), false);
  assert.equal(isManagedHostSupported("linux", "22.04", ""), false);
  assert.equal(isManagedHostSupported("linux", "22.04", "musl"), false);
  assert.equal(isManagedHostSupported("linux", "99.01", "2.42"), false);
  assert.equal(isManagedHostSupported("darwin", "13.5", "13.4"), false);
  assert.equal(isManagedHostSupported("darwin", "13.5", "14.0"), true);
  assert.equal(isManagedHostSupported("win32", "10.0", "10.0.26100"), true);
});

test("Linux host version comes from the running Node libc, and unknown libc fails closed", (t) => {
  resetHostProductVersionCacheForTests();
  t.after(resetHostProductVersionCacheForTests);
  t.mock.method(process.report, "getReport", () => ({ header: { glibcVersionRuntime: "2.35" } }));
  assert.equal(getHostProductVersion("linux"), "2.35");
  resetHostProductVersionCacheForTests();
  t.mock.method(process.report, "getReport", () => ({ header: {} }));
  assert.equal(getHostProductVersion("linux"), "");
});
