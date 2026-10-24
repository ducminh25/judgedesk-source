import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import type { AnnouncementPreviewContent } from "../../shared/announcements.js";
export interface CatalogEntry { uid: string; revision: number; publishedAt: string; status: "draft" | "published" | "archived" }
export interface Catalog { schemaVersion: 1; entries: CatalogEntry[] }
export interface Publication { sequence: number; generatedAt: string }
export interface SourceMetadata {
  uid: string; revision: number; publishedAt: string; updatedAt: string; expiresAt?: string;
  content: { vi: AnnouncementPreviewContent; en?: AnnouncementPreviewContent };
  images: { id: string; file: string; role: "article" | "thumbnail" }[]; thumbnailId?: string;
}
const uid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const positive = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const time = { type: "string", minLength: 24, maxLength: 24 };
const id = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" };
const content = { type: "object", additionalProperties: false, required: ["title", "summary"], properties: { title: { type: "string", minLength: 1, maxLength: 200 }, summary: { type: "string", minLength: 1, maxLength: 500 } } };
const ajv = new Ajv({ strict: true, ownProperties: true });
export const validateCatalog = ajv.compile<Catalog>({
  type: "object", additionalProperties: false, required: ["schemaVersion", "entries"],
  properties: {
    schemaVersion: { const: 1 },
    entries: {
      type: "array", maxItems: 10000,
      items: {
        type: "object", additionalProperties: false, required: ["uid", "revision", "publishedAt", "status"],
        properties: { uid, revision: positive, publishedAt: time, status: { enum: ["draft", "published", "archived"] } },
      },
    },
  },
});
export const validatePublication = ajv.compile<Publication>({ type: "object", additionalProperties: false, required: ["sequence", "generatedAt"], properties: { sequence: positive, generatedAt: time } });
export const validateSource = ajv.compile<SourceMetadata>({ type: "object", additionalProperties: false, required: ["uid", "revision", "publishedAt", "updatedAt", "content", "images"], properties: {
  uid, revision: positive, publishedAt: time, updatedAt: time, expiresAt: time, thumbnailId: id,
  content: { type: "object", additionalProperties: false, required: ["vi"], properties: { vi: content, en: content } },
  images: { type: "array", maxItems: 9, items: { type: "object", additionalProperties: false, required: ["id", "file", "role"], properties: { id, file: { type: "string", pattern: "^images/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\\.(jpg|jpeg|png)$" }, role: { enum: ["article", "thumbnail"] } } } },
} });

/** Reads only a frozen checkout. Local OS-user races against the checkout are outside the publisher trust boundary. */
export class SourceReader {
  private constructor(readonly root: string) {}
  static async create(root: string): Promise<SourceReader> {
    const absolute = path.resolve(root); const canonical = await realpath(absolute);
    if (!(await lstat(absolute)).isDirectory() || (await lstat(absolute)).isSymbolicLink()) throw new Error("Source root is a link or invalid directory");
    // Canonicalize OS ancestors (notably /var -> /private/var on macOS), then
    // reject every link inside the owned source tree when traversing it.
    return new SourceReader(canonical);
  }
  async read(relative: string, maximum: number): Promise<Buffer> {
    if (path.isAbsolute(relative) || relative.includes("\\") || relative.includes(":") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid source path");
    let current = this.root;
    for (const component of relative.split("/")) { current = path.join(current, component); if ((await lstat(current)).isSymbolicLink()) throw new Error("Source link rejected"); }
    const metadata = await lstat(current);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Source hard link or non-file rejected");
    if (metadata.size > maximum) throw new Error("Source byte limit exceeded");
    const file = await open(current, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maximum + 1, metadata.size + 1)); let length = 0;
      while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length > maximum || length > metadata.size) throw new Error("Source grew beyond its byte limit");
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  }
  async json(relative: string, maximum = 4 * 1024 * 1024): Promise<unknown> { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.read(relative, maximum))); }
  async files(): Promise<string[]> {
    const files: string[] = []; let count = 0;
    const visit = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(this.root, relative), { withFileTypes: true })) {
        if (++count > 20000) throw new Error("Source file count limit exceeded");
        const next = `${relative}/${entry.name}`;
        const metadata = await lstat(path.join(this.root, next));
        if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) throw new Error("Source link or special file rejected");
        if (metadata.isDirectory()) {
          if (!/^announcements\/posts(?:\/[0-9a-f-]{36}(?:\/images)?)?$/.test(next)) throw new Error("Unsupported source directory path");
          await visit(next);
        } else files.push(next);
      }
    };
    await visit("announcements"); return files.sort();
  }
}
