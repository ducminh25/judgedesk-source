import { invoke } from "@tauri-apps/api/core";
import type { AnnouncementArticleView, AnnouncementSnapshot } from "../../../shared/announcements.js";
export interface AnnouncementClient {
  snapshot(): Promise<AnnouncementSnapshot>; refresh(reason?: "session" | "stale" | "manual"): Promise<AnnouncementSnapshot>;
  setRead(uid: string, read: boolean): Promise<AnnouncementSnapshot>;
  markAllRead(uids: string[]): Promise<AnnouncementSnapshot>;
  delete(uid: string): Promise<AnnouncementSnapshot>;
  openArticle(uid: string, feedHash: string): Promise<AnnouncementArticleView>;
  closeArticle(viewId: string): Promise<void>;
  image(viewId: string, imageId: string): Promise<ArrayBuffer>;
  thumbnail(uid: string, feedHash: string): Promise<ArrayBuffer>;
  openLink(viewId: string, linkId: string): Promise<void>;
}
function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) return Promise.reject(new Error("desktopOnly"));
  return invoke<T>(command, args);
}
async function binary(command: string, args: Record<string, unknown>, maximum: number): Promise<ArrayBuffer> {
  const bytes = await native<ArrayBuffer>(command, args);
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > maximum) throw new Error("image");
  return bytes;
}
export const announcementClient: AnnouncementClient = {
  snapshot: () => native("announcements_snapshot"), refresh: (reason = "manual") => native("announcements_refresh", { reason }),
  setRead: (uid, read) => native("announcements_set_read", { uid, read }),
  markAllRead: (uids) => native("announcements_mark_all_read", { uids }),
  delete: (uid) => native("announcements_delete", { uid }),
  openArticle: (uid, feedHash) => native("announcements_article_open", { uid, feedHash }),
  closeArticle: (viewId) => native("announcements_article_close", { viewId }),
  image: (viewId, imageId) => binary("announcements_image", { viewId, imageId }, 4 * 1024 * 1024),
  thumbnail: (uid, feedHash) => binary("announcements_thumbnail", { uid, feedHash }, 128 * 1024),
  openLink: (viewId, linkId) => native("announcements_open_link", { viewId, linkId }),
};
