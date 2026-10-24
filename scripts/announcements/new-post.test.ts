import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { newPost } from "./new-post.js";
test("new-post reserves a permanent random UID and preserves existing catalog entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "judgedesk-new-post-"));
  try {
    await mkdir(path.join(root, "announcements/posts"), { recursive: true });
    await writeFile(path.join(root, "announcements/catalog.json"), JSON.stringify({ schemaVersion: 1, entries: [] }));
    const first = await newPost(root, { title: "Tin mới", summary: "Nội dung" });
    const second = await newPost(root, { title: "Tin mới", summary: "Nội dung" });
    assert.notEqual(first, second); assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const catalog = JSON.parse(await readFile(path.join(root, "announcements/catalog.json"), "utf8"));
    assert.deepEqual(catalog.entries.map((entry: { uid: string }) => entry.uid), [first, second]);
    assert.equal(catalog.entries[0].status, "draft");
    assert.ok((await readFile(path.join(root, `announcements/posts/${first}/vi.html`), "utf8")).includes("<p>"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
