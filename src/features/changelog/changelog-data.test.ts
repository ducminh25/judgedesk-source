import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANGELOG_DATA_EN,
  CHANGELOG_DATA_VI,
  getChangelogForLanguage,
} from "./changelog-data.js";

test("changelog data contains versions from 1.4.2 down to 1.2.5 in descending order", () => {
  const versionsVi = CHANGELOG_DATA_VI.map((r) => r.version);
  const versionsEn = CHANGELOG_DATA_EN.map((r) => r.version);

  const expectedVersions = [
    "1.4.2",
    "1.4.1",
    "1.4.0",
    "1.3.83",
    "1.3.82",
    "1.3.8",
    "1.3.7",
    "1.3.6",
    "1.3.5",
    "1.3.4",
    "1.3.3",
    "1.3.2",
    "1.3.0",
    "1.2.7",
    "1.2.6",
    "1.2.5",
  ];

  assert.deepEqual(versionsVi, expectedVersions);
  assert.deepEqual(versionsEn, expectedVersions);
});

test("every version has sections and non-empty bullet items", () => {
  for (const release of CHANGELOG_DATA_VI) {
    assert.ok(release.version.length > 0);
    assert.ok(release.date.length > 0);
    assert.ok(release.sections.length > 0);
    for (const section of release.sections) {
      assert.ok(section.title.length > 0);
      assert.ok(section.items.length > 0);
      for (const item of section.items) {
        assert.ok(item.trim().length > 0);
      }
    }
  }
});

test("getChangelogForLanguage returns appropriate language release list", () => {
  const vi = getChangelogForLanguage("vi");
  const en = getChangelogForLanguage("en");
  assert.equal(vi[0].sections[0].title, "Tương thích Custom Checker Đa Định dạng & Tự động Nạp Header");
  assert.equal(en[0].sections[0].title, "Multi-format Custom Checker (.exe, .cpp, .py) & Auto Header Staging");
});
