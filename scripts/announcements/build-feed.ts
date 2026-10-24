import { createHash } from "node:crypto";
import type { AnnouncementImage, AnnouncementItem, AnnouncementPayload } from "../../shared/announcements.js";
import { assertAnnouncementPayload } from "./validate-payload.js";
import { SourceReader, validateCatalog, validatePublication, validateSource, type Catalog } from "./source.js";
import { sanitizeSource } from "./sanitize-source.js";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const SITE_LIMIT = 512 * 1024 * 1024;
export interface BuiltFeed { payload: AnnouncementPayload; payloadBytes: Buffer; media: Map<string, Buffer>; catalog: Catalog; allItems: Map<string, AnnouncementItem> }

async function build(root: string): Promise<BuiltFeed> {
  const reader = await SourceReader.create(root);
  const catalog = await reader.json("announcements/catalog.json");
  const publication = await reader.json("announcements/publication.json", 4096);
  if (!validateCatalog(catalog) || !validatePublication(publication)) throw new Error("Invalid catalog/publication schema");
  const identities = new Set(catalog.entries.map((entry) => entry.uid));
  if (identities.size !== catalog.entries.length) throw new Error("Duplicate catalog UID");
  const files = await reader.files(); const media = new Map<string, Buffer>(); const imageFiles = new Map<string, { name: string; bytes: Buffer; mime: "image/png" | "image/jpeg"; extension: "png" | "jpg" }>();
  let total = 0;
  for (const file of files) {
    if (/^announcements\/(publication|catalog|publisher\.lock)\.json$/.test(file)) continue;
    const match = /^announcements\/posts\/([0-9a-f-]{36})\/(metadata\.json|vi\.html|en\.html|images\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:jpg|jpeg|png))$/.exec(file);
    if (!match || !identities.has(match[1])) throw new Error("Uncatalogued UID or unsupported source path");
    if (!match[2].startsWith("images/")) continue;
    const bytes = await reader.read(file, 4 * 1024 * 1024);
    const png = file.endsWith(".png");
    const header = png ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!header) throw new Error("Image extension/header mismatch; only PNG/JPEG are supported");
    const extension = png ? "png" : "jpg"; const name = `${sha256(bytes)}.${extension}`;
    if (!media.has(name)) { total += bytes.length; if (total > SITE_LIMIT) throw new Error("Pages media budget exceeded; old media must not be removed automatically"); media.set(name, bytes); }
    imageFiles.set(file, { name, bytes, mime: png ? "image/png" : "image/jpeg", extension });
  }
  const allItems = new Map<string, AnnouncementItem>();
  const items: AnnouncementItem[] = [];
  for (const entry of catalog.entries) {
    if (entry.status === "draft") continue;
    const prefix = `announcements/posts/${entry.uid}`;
    const source = await reader.json(`${prefix}/metadata.json`, 128 * 1024);
    if (!validateSource(source)) throw new Error("Invalid source metadata schema");
    if (source.uid !== entry.uid || source.revision !== entry.revision || source.publishedAt !== entry.publishedAt) throw new Error("Catalog identity/revision does not match metadata");
    const images: AnnouncementImage[] = source.images.map((image) => {
      const file = imageFiles.get(`${prefix}/${image.file}`); if (!file) throw new Error("Missing source image path");
      if (image.role === "thumbnail" && file.bytes.length > 128 * 1024) throw new Error("Thumbnail byte limit exceeded");
      return { id: image.id, sha256: file.name.split(".")[0], sizeBytes: file.bytes.length, extension: file.extension, mime: file.mime, role: image.role };
    });
    const links: AnnouncementItem["links"] = [];
    const vi = sanitizeSource(new TextDecoder("utf-8", { fatal: true }).decode(await reader.read(`${prefix}/vi.html`, 64 * 1024)), images, links);
    const en = source.content.en ? sanitizeSource(new TextDecoder("utf-8", { fatal: true }).decode(await reader.read(`${prefix}/en.html`, 64 * 1024)), images, links) : undefined;
    const item: AnnouncementItem = { uid: entry.uid, revision: entry.revision, publishedAt: source.publishedAt, updatedAt: source.updatedAt,
      ...(source.expiresAt ? { expiresAt: source.expiresAt } : {}), content: { vi: { ...source.content.vi, html: vi }, ...(source.content.en && en ? { en: { ...source.content.en, html: en } } : {}) }, images, links,
      ...(source.thumbnailId ? { thumbnailId: source.thumbnailId } : {}) };
    // Archived content remains validated so reintroduction cannot discard identity history.
    assertAnnouncementPayload({ schemaVersion: 1, feedId: "judgedesk-announcements", ...publication, items: [item] });
    allItems.set(entry.uid, item); if (entry.status === "published") items.push(item);
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.uid.localeCompare(b.uid));
  const payload: AnnouncementPayload = { schemaVersion: 1, feedId: "judgedesk-announcements", sequence: publication.sequence, generatedAt: publication.generatedAt, items };
  assertAnnouncementPayload(payload);
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  if (payloadBytes.length + total > SITE_LIMIT) throw new Error("Pages artifact budget exceeded");
  return { payload, payloadBytes, media, catalog, allItems };
}

export async function buildFeed(root: string, options: { previousRoot?: string } = {}): Promise<BuiltFeed> {
  const current = await build(root);
  if (!options.previousRoot) return current;
  const previous = await build(options.previousRoot);
  for (const old of previous.catalog.entries) {
    const next = current.catalog.entries.find((entry) => entry.uid === old.uid);
    if (!next || old.publishedAt !== next.publishedAt || next.revision < old.revision || (old.status !== "draft" && next.status === "draft")) throw new Error("Catalog UID identity/history cannot be removed or rewritten");
    const oldItem = previous.allItems.get(old.uid); const nextItem = current.allItems.get(old.uid);
    if (oldItem && (!nextItem || (sha256(JSON.stringify(oldItem)) !== sha256(JSON.stringify(nextItem)) && next.revision <= old.revision))) throw new Error("Published content changes require an increased revision");
  }
  for (const name of previous.media.keys()) if (!current.media.has(name)) throw new Error("Historical media must remain in source; never remove previously published images");
  if (current.payload.sequence < previous.payload.sequence || (current.payload.sequence === previous.payload.sequence && (!current.payloadBytes.equals(previous.payloadBytes) || current.media.size !== previous.media.size))) throw new Error("Artifact changes require an increased publication sequence");
  return current;
}
