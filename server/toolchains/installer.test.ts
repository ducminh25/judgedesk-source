import assert from "node:assert/strict";
import test from "node:test";
import { uninstallToolchain } from "./installer.js";

test("uninstall rejects unknown and traversal-like toolchain IDs", () => {
  assert.throws(() => uninstallToolchain(".."), /Unknown toolchain package/);
  assert.throws(
    () => uninstallToolchain("not-in-the-catalog"),
    /Unknown toolchain package/,
  );
});
