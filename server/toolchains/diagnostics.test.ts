import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseLanguageProfile } from "./diagnostics.js";

test("diagnostics rejects unknown language profiles gracefully", async () => {
  const result = await diagnoseLanguageProfile("non_existent_profile_xyz");
  assert.equal(result.success, false);
  assert.equal(result.phase, "configuration");
  assert.match(result.error || "", /not registered/i);
});

test("diagnostics returns configuration error when a toolchain is not ready or none selected", async () => {
  // Test with a profile ID that might not be installed or none selected
  const result = await diagnoseLanguageProfile("csharp");
  assert.equal(result.success, false);
  assert.equal(result.phase, "configuration");
  assert.ok(result.error);
});

test("diagnoses scratch language profile successfully", async () => {
  const result = await diagnoseLanguageProfile("scratch-turbowarp-v1");
  assert.equal(result.language, "scratch");
  assert.equal(result.profileId, "scratch-turbowarp-v1");
});

