import type { AnnouncementSnapshot, AnnouncementArticleView } from "../../../shared/announcements.js";
export const EMPTY_ANNOUNCEMENTS: AnnouncementSnapshot = { localRevision: -1, feedHash: null, sequence: null, checkedAt: null, items: [] };
export function badge(count: number): string { return count <= 0 ? "" : count > 9 ? "9+" : String(count); }
export function visibleItems(snapshot: AnnouncementSnapshot, now: string) {
  return snapshot.items.filter((item) => !item.deleted && (!item.expiresAt || item.expiresAt > now))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.uid.localeCompare(b.uid));
}
export function acceptSnapshot(current: AnnouncementSnapshot, incoming: AnnouncementSnapshot): AnnouncementSnapshot {
  return incoming.localRevision > current.localRevision ? incoming : current;
}
export function pinnedArticleChanged(view: AnnouncementArticleView, snapshot: AnnouncementSnapshot, now: string): boolean {
  const current = visibleItems(snapshot, now).find((item) => item.uid === view.item.uid);
  // Native history validation requires a revision bump for every content change.
  return !current || current.revision !== view.item.revision;
}
