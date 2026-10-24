/** Wire contracts only; network, persistence and HTML rendering belong to their owning tiers. */
export const ANNOUNCEMENT_FORMAT = "judgedesk-announcements-v1";
export const ANNOUNCEMENT_FEED_ID = "judgedesk-announcements";
export const ANNOUNCEMENT_SIGNING_PREFIX = "JudgeDesk announcements v1\n";
export const ANNOUNCEMENT_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ANNOUNCEMENT_LIMITS = {
  payloadBytes: 1024 * 1024,
  envelopeBytes: 1536 * 1024,
  articleHtmlBytes: 64 * 1024,
  articleImageBytes: 4 * 1024 * 1024,
  thumbnailBytes: 128 * 1024,
  articleImages: 8,
  items: 100,
  links: 64,
} as const;

export interface AnnouncementEnvelope {
  format: typeof ANNOUNCEMENT_FORMAT;
  keyId: string;
  payloadBase64: string;
  signatureBase64: string;
}

export interface AnnouncementContent {
  title: string;
  summary: string;
  /** Untrusted HTML, even after signature verification; sanitize before rendering. */
  html: string;
}

export interface AnnouncementImage {
  id: string;
  sha256: string;
  sizeBytes: number;
  mime: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
  role: "article" | "thumbnail";
}

export interface AnnouncementLink {
  id: string;
  url: string;
}

export interface AnnouncementItem {
  uid: string;
  revision: number;
  publishedAt: string;
  updatedAt: string;
  expiresAt?: string;
  content: { vi: AnnouncementContent; en?: AnnouncementContent };
  images: AnnouncementImage[];
  links: AnnouncementLink[];
  thumbnailId?: string;
}

export interface AnnouncementPayload {
  schemaVersion: 1;
  feedId: typeof ANNOUNCEMENT_FEED_ID;
  sequence: number;
  generatedAt: string;
  items: AnnouncementItem[];
}

export type AnnouncementPreviewContent = Omit<AnnouncementContent, "html">;
export interface AnnouncementPreview {
  uid: string; revision: number; publishedAt: string; updatedAt: string; expiresAt?: string;
  content: { vi: AnnouncementPreviewContent; en?: AnnouncementPreviewContent };
  readAt: string | null; deleted: boolean; thumbnail?: AnnouncementImage;
}
export interface AnnouncementSnapshot {
  localRevision: number; feedHash: string | null; sequence: number | null;
  checkedAt: string | null; items: AnnouncementPreview[];
}
export interface AnnouncementArticleView { viewId: string; feedHash: string; item: AnnouncementItem }
