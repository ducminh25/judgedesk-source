import assert from "node:assert/strict";
import test from "node:test";
import { uninstallToolchain } from "./installer.js";

test("uninstall rejects unknown and traversal-like toolchain IDs", async () => {
  await assert.rejects(
    uninstallToolchain(".."),
    /Unknown toolchain package/,
  );
  await assert.rejects(
    uninstallToolchain("not-in-the-catalog"),
    /Unknown toolchain package/,
  );
});
