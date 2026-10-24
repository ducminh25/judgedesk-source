import assert from "node:assert/strict";
import { test } from "node:test";
import { badge, visibleItems, acceptSnapshot, pinnedArticleChanged } from "./announcement-model.js";
import type { AnnouncementSnapshot } from "../../../shared/announcements.js";

const snapshot = (revision: number): AnnouncementSnapshot => ({ localRevision: revision, feedHash: "a".repeat(64), sequence: 1, checkedAt: null, items: [
  { uid: "new", revision: 1, publishedAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z", content: { vi: { title: "Mới", summary: "Nội dung" } }, readAt: null, deleted: false },
  { uid: "old", revision: 1, publishedAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z", content: { vi: { title: "Cũ", summary: "" } }, readAt: "2026-10-23T00:00:00.000Z", deleted: false },
] });
test("badge uses exact counts accessibly and caps the visual count at 9+", () => {
  for (const [count, label] of [[0, ""], [1, "1"], [8, "8"], [9, "9"], [10, "9+"], [100, "9+"]] as const) assert.equal(badge(count), label);
});
test("deleted/expired items disappear without changing persistent read state; newest first", () => {
  const input = snapshot(1); input.items.reverse();
  assert.deepEqual(visibleItems(input, "2026-10-24T00:00:00.000Z").map((item) => item.uid), ["new", "old"]);
  input.items[0].expiresAt = "2026-10-24T00:00:00.000Z";
  input.items[1].deleted = true;
  assert.deepEqual(visibleItems(input, "2026-10-24T00:00:00.000Z"), []);
  assert.equal(input.items[0].readAt, "2026-10-23T00:00:00.000Z");
});
test("late response cannot overwrite a newer read/delete commit", () => {
  const current = snapshot(3); current.items[0].deleted = true;
  assert.equal(acceptSnapshot(current, snapshot(2)), current);
  assert.equal(acceptSnapshot(current, snapshot(3)), current);
  assert.equal(acceptSnapshot(current, snapshot(4)).localRevision, 4);
});
test("an unrelated feed publication must not claim that the open article changed", () => {
  const current = snapshot(1);
  const article = { viewId: "view", feedHash: current.feedHash!, item: {
    uid: "new", revision: 1, publishedAt: current.items[0].publishedAt, updatedAt: current.items[0].updatedAt,
    content: { vi: { title: "Mới", summary: "Nội dung", html: "<p>Nội dung</p>" } }, images: [], links: [],
  } };
  current.feedHash = "b".repeat(64);
  assert.equal(pinnedArticleChanged(article, current, "2026-10-24T00:00:00.000Z"), false);
  current.items[0].revision = 2;
  assert.equal(pinnedArticleChanged(article, current, "2026-10-24T00:00:00.000Z"), true);
  current.items[0].revision = 1; current.items[0].deleted = true;
  assert.equal(pinnedArticleChanged(article, current, "2026-10-24T00:00:00.000Z"), true);
});
