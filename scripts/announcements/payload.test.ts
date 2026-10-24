import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ANNOUNCEMENT_LIMITS } from "../../shared/announcements.js";
import {
  assertAnnouncementEnvelope,
  assertAnnouncementPayload,
} from "./validate-payload.js";

const fixtureUrl = new URL("../../shared/test-fixtures/announcements/signed-feed.json", import.meta.url);

function payload(): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  return JSON.parse(Buffer.from(fixture.envelope.payloadBase64, "base64").toString("utf8"));
}

function item(value: Record<string, unknown>): Record<string, unknown> {
  return (value.items as Record<string, unknown>[])[0];
}

test("announcement contract accepts the independent signed fixture and an empty feed", () => {
  const value = payload();
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  value.items = [];
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assert.doesNotThrow(() => assertAnnouncementEnvelope(fixture.envelope));
});

test("announcement validation rejects unsupported fields without stripping or coercing them", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => { value.sequence = "1"; },
    (value: Record<string, unknown>) => { value.sequence = Number.MAX_SAFE_INTEGER + 1; },
    (value: Record<string, unknown>) => { value.sequence = 0; },
    (value: Record<string, unknown>) => { value.schemaVersion = 2; },
    (value: Record<string, unknown>) => { value.feedId = "other-product"; },
    (value: Record<string, unknown>) => { value.remoteCommand = "run"; },
    (value: Record<string, unknown>) => { item(value).uid = "same-title"; },
    (value: Record<string, unknown>) => { item(value).revision = 1.5; },
  ]) {
    const value = payload();
    mutate(value);
    const original = JSON.stringify(value);
    assert.throws(() => assertAnnouncementPayload(value), /announcement/i);
    assert.equal(JSON.stringify(value), original);
  }
});

test("announcement validation requires own properties and unique UIDs", () => {
  const value = payload();
  assert.throws(() => assertAnnouncementPayload(Object.create(value)), /announcement/i);
  const first = item(value);
  value.items = [first, structuredClone(first)];
  assert.throws(() => assertAnnouncementPayload(value), /duplicate.*uid/i);
});

test("timestamps must be real canonical UTC instants in chronological order", () => {
  for (const [invalid, diagnostic] of [
    ["2026-02-30T00:00:00.000Z", /timestamp/i],
    ["2026-10-23", /generatedAt/i],
    ["2026-10-23T07:00:00+07:00", /generatedAt/i],
  ] as const) {
    const value = payload();
    value.generatedAt = invalid;
    assert.throws(() => assertAnnouncementPayload(value), diagnostic);
  }
  const value = payload();
  item(value).updatedAt = "2026-10-22T00:00:00.000Z";
  assert.throws(() => assertAnnouncementPayload(value), /updatedAt/i);
  item(value).updatedAt = "2026-10-23T00:00:00.000Z";
  item(value).expiresAt = item(value).publishedAt;
  assert.throws(() => assertAnnouncementPayload(value), /expiresAt/i);
});

test("Vietnamese is required and text limits use UTF-8 bytes with well-formed Unicode", () => {
  const value = payload();
  const content = item(value).content as Record<string, Record<string, unknown>>;
  delete content.vi;
  assert.throws(() => assertAnnouncementPayload(value), /announcement/i);
  content.vi = { title: "Bài mới", summary: "Mô tả", html: "é".repeat(32_769) };
  assert.throws(() => assertAnnouncementPayload(value), /html.*bytes/i);
  content.vi.html = "é".repeat(32_768);
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  content.vi.title = "\ud800";
  assert.throws(() => assertAnnouncementPayload(value), /unicode/i);
  content.vi.title = "   ";
  assert.throws(() => assertAnnouncementPayload(value), /blank/i);
});

test("images have unique IDs, a matching format and bounded article/thumbnail roles", () => {
  const value = payload();
  const article = item(value);
  const image = { id: "guide", sha256: "a".repeat(64), sizeBytes: 1024, mime: "image/jpeg", extension: "jpg", role: "article" };
  article.images = [image];
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  for (const overrides of [
    { mime: "image/svg+xml" },
    { extension: "jpeg" },
    { extension: "png" },
    { id: "../guide" },
    { sha256: "A".repeat(64) },
    { sizeBytes: 4 * 1024 * 1024 + 1 },
    { url: "https://example.com/photo.jpg" },
  ]) {
    article.images = [{ ...image, ...overrides }];
    assert.throws(() => assertAnnouncementPayload(value), /announcement|image/i);
  }
  article.images = [image, structuredClone(image)];
  assert.throws(() => assertAnnouncementPayload(value), /duplicate.*image/i);
  article.images = [{ ...image, role: "thumbnail", sizeBytes: 128 * 1024 }];
  article.thumbnailId = "guide";
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  article.thumbnailId = "missing";
  assert.throws(() => assertAnnouncementPayload(value), /thumbnail/i);
});

test("link validation protects the exact repo and Pages path boundaries", () => {
  const value = payload();
  const article = item(value);
  for (const url of [
    "https://github.com/ducminh25/judgedesk",
    "https://github.com/ducminh25/judgedesk/releases/tag/v1.6.0",
    "https://ducminh25.github.io/judgedesk/guide.html#install",
  ]) {
    article.links = [{ id: "guide", url }];
    assert.doesNotThrow(() => assertAnnouncementPayload(value));
  }
  for (const url of [
    "javascript:alert(1)", "file:///etc/passwd", "http://github.com/ducminh25/judgedesk",
    "https://github.com/ducminh25/judgedesk-other", "https://ducminh25.github.io/another-project/",
    "https://github.com.evil.test/ducminh25/judgedesk", "https://user@github.com/ducminh25/judgedesk",
    "https://github.com:444/ducminh25/judgedesk", "https://github.com/ducminh25/judgedesk/%2f..",
    "https://github.com/ducminh25/judgedesk/%252e%252e", "https://github.com/ducminh25/judgedesk/../other",
    "https://github.com/ducminh25/judgedesk\\other", "https://github.com/ducminh25/judgedesk/%00",
  ]) {
    article.links = [{ id: "guide", url }];
    assert.throws(() => assertAnnouncementPayload(value), /link/i, url);
  }
  article.links = [{ id: "guide", url: "https://github.com/ducminh25/judgedesk" }, { id: "guide", url: "https://github.com/ducminh25/judgedesk" }];
  assert.throws(() => assertAnnouncementPayload(value), /duplicate.*link/i);
});

test("the aggregate byte cap applies even if each article is within its own cap", () => {
  const value = payload();
  const original = item(value);
  value.items = Array.from({ length: 20 }, (_, index) => ({
    ...original,
    uid: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    content: { vi: { title: "Bài mới", summary: "Mô tả", html: "x".repeat(64 * 1024) } },
  }));
  assert.throws(() => assertAnnouncementPayload(value), /payload.*bytes/i);
});

test("item and link limits accept the boundary and reject the next entry", () => {
  const value = payload();
  const original = item(value);
  value.sequence = Number.MAX_SAFE_INTEGER;
  value.items = Array.from({ length: ANNOUNCEMENT_LIMITS.items }, (_, index) => ({
    ...original,
    uid: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    revision: Number.MAX_SAFE_INTEGER,
  }));
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  (value.items as unknown[]).push({ ...original, uid: "ffffffff-0000-4000-8000-000000000000" });
  assert.throws(() => assertAnnouncementPayload(value), /items/i);
  value.items = [original];
  original.links = Array.from({ length: ANNOUNCEMENT_LIMITS.links }, (_, index) => ({
    id: `link-${index}`, url: "https://github.com/ducminh25/judgedesk",
  }));
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  (original.links as unknown[]).push({ id: "last", url: "https://github.com/ducminh25/judgedesk" });
  assert.throws(() => assertAnnouncementPayload(value), /links/i);
});

test("image role and byte boundaries support PNG and optional dedicated thumbnails", () => {
  const value = payload();
  const article = item(value);
  const image = { id: "guide", sha256: "b".repeat(64), sizeBytes: ANNOUNCEMENT_LIMITS.articleImageBytes, mime: "image/png", extension: "png", role: "article" };
  const images = Array.from({ length: ANNOUNCEMENT_LIMITS.articleImages }, (_, index) => ({ ...image, id: `guide-${index}` }));
  article.images = images;
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  images.push({ ...image, id: "guide-last" });
  assert.throws(() => assertAnnouncementPayload(value), /image role count/i);
  images.pop();
  const thumbnail = { ...image, id: "preview", role: "thumbnail", sizeBytes: ANNOUNCEMENT_LIMITS.thumbnailBytes };
  article.images = [...images, thumbnail];
  article.thumbnailId = "preview";
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  thumbnail.sizeBytes += 1;
  assert.throws(() => assertAnnouncementPayload(value), /thumbnail.*bytes/i);
  thumbnail.sizeBytes -= 1;
  delete article.thumbnailId;
  assert.throws(() => assertAnnouncementPayload(value), /thumbnailId/i);
});

test("locale character limits count Unicode code points, and metadata validation does not sanitize HTML", () => {
  const value = payload();
  const vi = (item(value).content as Record<string, Record<string, unknown>>).vi;
  vi.title = "😀".repeat(200);
  vi.html = '<p onclick="alert(1)">Nội dung</p>';
  const originalHtml = vi.html;
  assert.doesNotThrow(() => assertAnnouncementPayload(value));
  assert.equal(vi.html, originalHtml);
  vi.title += "😀";
  assert.throws(() => assertAnnouncementPayload(value), /title/i);
});
