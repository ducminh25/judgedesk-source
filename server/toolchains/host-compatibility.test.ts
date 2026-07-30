import assert from "node:assert/strict";
import test from "node:test";
import { isMinimumOsSupported } from "./host-compatibility.js";

test("minimum OS checks compare numeric product versions and fail closed", () => {
  assert.equal(isMinimumOsSupported("13.5", "13.5"), true);
  assert.equal(isMinimumOsSupported("13.5", "14.0"), true);
  assert.equal(isMinimumOsSupported("14.0", "13.6.9"), false);
  assert.equal(isMinimumOsSupported("10.0", "10.0.26100"), true);
  assert.equal(isMinimumOsSupported("14.0", "unknown"), false);
});
