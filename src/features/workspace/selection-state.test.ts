import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSelection } from "./selection-state.js";

test("reload preserves known selections and selects newly discovered entries", () => {
  assert.deepEqual(
    reconcileSelection(["Alice", "Bob", "Carol"], {
      Alice: false,
      Bob: true,
      Removed: false,
    }),
    {
      Alice: false,
      Bob: true,
      Carol: true,
    },
  );
});
