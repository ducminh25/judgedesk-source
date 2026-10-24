import assert from "node:assert/strict";
import { test } from "node:test";
import corpus from "../../shared/test-fixtures/announcements/payload-validation.json" with { type: "json" };
import { assertAnnouncementPayload } from "./validate-payload.js";

// Native-only duplicate-key cases are separate: this API validates already parsed objects.
for (const fixture of corpus.cases) {
  test(`announcement metadata corpus: ${fixture.name}`, () => {
    let accepted = false;
    try {
      const value: unknown = JSON.parse(fixture.json);
      assertAnnouncementPayload(value);
      accepted = true;
      assert.equal(JSON.stringify(value), "normalized" in fixture ? fixture.normalized : undefined);
    } catch (error) {
      if (fixture.valid) throw error;
    }
    assert.equal(accepted, fixture.valid);
  });
}
