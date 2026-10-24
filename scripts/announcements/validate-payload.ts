import Ajv from "ajv";
import schema from "../../shared/announcements.schema.json" with { type: "json" };
import {
  ANNOUNCEMENT_LIMITS,
  type AnnouncementEnvelope,
  type AnnouncementPayload,
} from "../../shared/announcements.js";

const ajv = new Ajv({ strict: true, ownProperties: true });
ajv.addSchema(schema);
const validatePayload = ajv.compile<AnnouncementPayload>({ $ref: `${schema.$id}#/definitions/payload` });
const validateEnvelope = ajv.compile<AnnouncementEnvelope>({ $ref: `${schema.$id}#/definitions/envelope` });

function timestamp(value: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    throw new Error("Announcement timestamp must be a real canonical UTC instant.");
  }
  return instant;
}

function assertText(value: string, field: string): void {
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error(`Announcement ${field} contains ill-formed Unicode.`);
  }
  if (!value.trim()) throw new Error(`Announcement ${field} must not be blank.`);
}

export function assertAnnouncementLink(value: string): void {
  const fail = () => { throw new Error("Announcement link is outside the approved HTTPS scope."); };
  if (/[\\\u0000-\u0020\u007f]/.test(value)) fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.href !== value) fail();
  const prefix = url.hostname === "github.com"
    ? "/ducminh25/judgedesk"
    : url.hostname === "ducminh25.github.io" ? "/judgedesk" : null;
  if (!prefix || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) fail();
  for (const segment of url.pathname.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return fail(); }
    if (decoded === "." || decoded === ".." || /[/%\\\u0000-\u001f\u007f]/.test(decoded)) fail();
  }
}

/** Validate metadata only. This deliberately does not sanitize HTML or decode image files. */
export function assertAnnouncementPayload(value: unknown): asserts value is AnnouncementPayload {
  if (!validatePayload(value)) {
    throw new Error(`Announcement payload schema is invalid at ${validatePayload.errors?.[0]?.instancePath || "/"}.`);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > ANNOUNCEMENT_LIMITS.payloadBytes) {
    throw new Error("Announcement payload exceeds the maximum bytes.");
  }
  timestamp(value.generatedAt);
  const uids = new Set<string>();
  for (const article of value.items) {
    if (uids.has(article.uid)) throw new Error("Duplicate announcement UID.");
    uids.add(article.uid);
    const published = timestamp(article.publishedAt);
    if (timestamp(article.updatedAt) < published) throw new Error("Announcement updatedAt precedes publishedAt.");
    if (article.expiresAt && timestamp(article.expiresAt) <= published) {
      throw new Error("Announcement expiresAt must follow publishedAt.");
    }
    for (const content of Object.values(article.content)) {
      assertText(content.title, "title");
      assertText(content.summary, "summary");
      assertText(content.html, "html");
      if (Buffer.byteLength(content.html, "utf8") > ANNOUNCEMENT_LIMITS.articleHtmlBytes) {
        throw new Error("Announcement html exceeds the maximum bytes.");
      }
    }
    const images = new Set<string>();
    let articleImages = 0;
    const thumbnails: string[] = [];
    for (const image of article.images) {
      if (images.has(image.id)) throw new Error("Duplicate announcement image ID.");
      images.add(image.id);
      if ((image.mime === "image/jpeg") !== (image.extension === "jpg")) {
        throw new Error("Announcement image MIME and extension do not match.");
      }
      if (image.role === "article") articleImages += 1;
      else {
        thumbnails.push(image.id);
        if (image.sizeBytes > ANNOUNCEMENT_LIMITS.thumbnailBytes) throw new Error("Announcement thumbnail exceeds the maximum bytes.");
      }
    }
    if (articleImages > ANNOUNCEMENT_LIMITS.articleImages || thumbnails.length > 1) {
      throw new Error("Announcement image role count exceeds the limit.");
    }
    if ((thumbnails.length === 1 && article.thumbnailId !== thumbnails[0])
      || (thumbnails.length === 0 && article.thumbnailId !== undefined)) {
      throw new Error("Announcement thumbnailId must identify its declared thumbnail.");
    }
    const links = new Set<string>();
    for (const link of article.links) {
      if (links.has(link.id)) throw new Error("Duplicate announcement link ID.");
      links.add(link.id);
      assertAnnouncementLink(link.url);
    }
  }
}

/** Checks shape only. Canonical base64 and authenticity are checked by the signature verifier. */
export function assertAnnouncementEnvelope(value: unknown): asserts value is AnnouncementEnvelope {
  if (!validateEnvelope(value)) throw new Error("Announcement signature envelope schema is invalid.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > ANNOUNCEMENT_LIMITS.envelopeBytes) {
    throw new Error("Announcement envelope exceeds the maximum bytes.");
  }
}
