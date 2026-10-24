import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SourceReader, validateCatalog, validateSource, type SourceMetadata } from "./source.js";

async function atomicCatalog(file: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.catalog-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  let committed = false;
  try {
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file); committed = true;
  } finally { if (!committed) await unlink(temporary); }
}

export async function newPost(root: string, content: { title: string; summary: string }): Promise<string> {
  const reader = await SourceReader.create(root);
  await reader.files();
  const posts = path.join(reader.root, "announcements/posts");
  const metadata = await lstat(posts);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Posts path must be a regular directory");
  // Exclusive creation serializes concurrent CLI writers. A crash leaves a visible lock
  // for manual inspection; do not guess that a recorded PID is safe to break/reuse.
  const lockPath = path.join(reader.root, "announcements/.new-post.lock");
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync();
    const catalog = await reader.json("announcements/catalog.json");
    if (!validateCatalog(catalog)) throw new Error("Invalid catalog schema");
    const uid = randomUUID(); const at = new Date().toISOString();
    const source: SourceMetadata = { uid, revision: 1, publishedAt: at, updatedAt: at, content: { vi: content }, images: [] };
    if (!validateSource(source) || !content.title.trim() || !content.summary.trim()) throw new Error("Invalid draft metadata schema");
    catalog.entries.push({ uid, revision: 1, publishedAt: at, status: "draft" });
    if (!validateCatalog(catalog)) throw new Error("Catalog capacity limit exceeded; no UID history is pruned");
    const post = path.join(posts, uid); await mkdir(post); await mkdir(path.join(post, "images"));
    await writeFile(path.join(post, "metadata.json"), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx", flush: true });
    await writeFile(path.join(post, "vi.html"), "<p>Soạn nội dung thông báo tại đây.</p>\n", { flag: "wx", flush: true });
    await atomicCatalog(path.join(reader.root, "announcements/catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    return uid;
  } finally { await lock.close(); await unlink(lockPath); }
}
