import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, cp, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeed } from "./build-feed.js";
const UID = "12345678-1234-4234-8234-123456789abc";
const NOW = "2026-10-24T00:00:00.000Z";
const metadata = () => ({ uid: UID, revision: 1, publishedAt: NOW, updatedAt: NOW, content: { vi: { title: "Thông báo", summary: "Nội dung mới" } }, images: [] });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "judgedesk-publisher-"));
  await mkdir(path.join(root, `announcements/posts/${UID}/images`), { recursive: true });
  await writeFile(path.join(root, "announcements/publication.json"), JSON.stringify({ sequence: 1, generatedAt: NOW }));
  await writeFile(path.join(root, "announcements/catalog.json"), JSON.stringify({ schemaVersion: 1, entries: [{ uid: UID, revision: 1, publishedAt: NOW, status: "published" }] }));
  await writeFile(path.join(root, `announcements/posts/${UID}/metadata.json`), JSON.stringify(metadata()));
  await writeFile(path.join(root, `announcements/posts/${UID}/vi.html`), '<p>Hello <strong>JudgeDesk</strong><script>bad()</script></p><a href="https://github.com/ducminh25/judgedesk/issues">Hướng dẫn</a>');
  return root;
}
test("publisher is deterministic, sanitizes author HTML and binds links without publishing raw HTML", async () => {
  const root = await fixture();
  try {
    const first = await buildFeed(root); const second = await buildFeed(root);
    assert.deepEqual(first.payloadBytes, second.payloadBytes);
    assert.equal(first.payload.items[0].links.length, 1);
    assert.ok(first.payload.items[0].content.vi.html.includes("data-announcement-link="));
    assert.ok(!/href=|script|onclick|src=/.test(first.payload.items[0].content.vi.html));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("publisher enforces identity/revision/sequence against previous source and accepts identical rerun", async () => {
  const root = await fixture(); const previous = await fixture();
  try {
    await buildFeed(root, { previousRoot: previous });
    await writeFile(path.join(root, `announcements/posts/${UID}/vi.html`), "<p>Changed</p>");
    await assert.rejects(buildFeed(root, { previousRoot: previous }), /revision/i);
    const next = { ...metadata(), revision: 2 };
    await writeFile(path.join(root, `announcements/posts/${UID}/metadata.json`), JSON.stringify(next));
    await writeFile(path.join(root, "announcements/catalog.json"), JSON.stringify({ schemaVersion: 1, entries: [{ uid: UID, revision: 2, publishedAt: NOW, status: "published" }] }));
    await assert.rejects(buildFeed(root, { previousRoot: previous }), /sequence/i);
    await writeFile(path.join(root, "announcements/publication.json"), JSON.stringify({ sequence: 2, generatedAt: NOW }));
    assert.equal((await buildFeed(root, { previousRoot: previous })).payload.sequence, 2);
    await writeFile(path.join(root, "announcements/catalog.json"), JSON.stringify({ schemaVersion: 1, entries: [] }));
    await assert.rejects(buildFeed(root, { previousRoot: previous }), /identity|catalog|UID/i);
  } finally { await rm(root, { recursive: true, force: true }); await rm(previous, { recursive: true, force: true }); }
});
test("publisher refuses hard links, traversal, unsupported images and unknown source fields", async () => {
  const root = await fixture();
  try {
    const post = path.join(root, `announcements/posts/${UID}`);
    const raw = path.join(post, "vi.html");
    await link(raw, path.join(post, "vi-linked.html"));
    await assert.rejects(buildFeed(root), /link/i);
    await rm(path.join(post, "vi-linked.html"));
    await writeFile(path.join(post, "metadata.json"), JSON.stringify({ ...metadata(), images: [{ id: "bad", file: "../../secret.png", role: "article" }] }));
    await assert.rejects(buildFeed(root), /path|image|schema/i);
    await writeFile(path.join(post, "metadata.json"), JSON.stringify({ ...metadata(), extra: true }));
    await assert.rejects(buildFeed(root), /schema/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher media/article output matches the shared Node-to-native golden vector", async () => {
  const root = new URL("../../shared/test-fixtures/announcements/publisher-source/", import.meta.url);
  const built = await buildFeed(fileURLToPath(root));
  const golden = JSON.parse(await readFile(new URL("../../shared/test-fixtures/announcements/publisher-feed.json", import.meta.url), "utf8"));
  assert.equal(built.payloadBytes.toString("base64"), golden.envelope.payloadBase64);
  assert.equal(built.payload.items[0].images.length, 2);
  assert.equal(built.payload.items[0].links.length, 1);
  assert.equal(built.media.size, 1);
  assert.ok(built.payload.items[0].content.en);
});
