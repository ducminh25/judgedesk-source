import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, CheckCheck, MoreHorizontal, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AnnouncementPreview } from "../../../shared/announcements.js";
import type { AnnouncementClient } from "./announcement-client.js";
import { AnnouncementMedia } from "./AnnouncementMedia.js";
import type { useAnnouncements } from "./useAnnouncements.js";

function focusPanelAction(panel: HTMLDivElement | null) {
  if (panel) (panel.querySelector<HTMLButtonElement>('button:not([disabled])') ?? panel).focus({ preventScroll: true });
}

function Thumbnail({ item, feedHash, client }: { item: AnnouncementPreview; feedHash: string; client: AnnouncementClient }) {
  const load = useCallback(() => client.thumbnail(item.uid, feedHash), [client, feedHash, item.uid]);
  return item.thumbnail ? <AnnouncementMedia image={item.thumbnail} alt="" load={load} thumbnail /> : <span className="announcement-thumbnail"><Bell className="h-5 w-5" aria-hidden="true" /></span>;
}
export function NotificationPopover({ anchor, state, items, client, articlePending, scrollTop, selectedUid, onScroll, onClose, onOpen }: {
  anchor: HTMLButtonElement; state: ReturnType<typeof useAnnouncements>; items: AnnouncementPreview[]; client: AnnouncementClient;
  articlePending: boolean; scrollTop: number; selectedUid: string | null; onScroll: (top: number) => void;
  onClose: (restoreFocus: boolean) => void; onOpen: (item: AnnouncementPreview) => void;
}) {
  const { t, i18n } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [menuUid, setMenuUid] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 50, maxHeight: 400 });
  const restoration = useRef({ scrollTop, selectedUid });
  const pendingDelete = useRef<{ uid: string; index: number } | null>(null);
  const closeHandler = useRef(onClose); closeHandler.current = onClose;
  useLayoutEffect(() => {
    const reposition = () => {
      const box = anchor.getBoundingClientRect(); const width = Math.min(400, window.innerWidth - 16);
      if (box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) { closeHandler.current(false); return; }
      const top = Math.max(8, Math.min(box.bottom + 8, window.innerHeight - 100));
      setPosition({ left: Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)), top, maxHeight: Math.max(80, window.innerHeight - top - 8) });
    };
    reposition();
    window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition); window.visualViewport?.addEventListener("scroll", reposition);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    observer?.observe(anchor); if (anchor.parentElement) observer?.observe(anchor.parentElement);
    return () => { observer?.disconnect(); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); window.visualViewport?.removeEventListener("resize", reposition); window.visualViewport?.removeEventListener("scroll", reposition); };
  }, [anchor, items.length]);
  useEffect(() => {
    if (menuUid) panel.current?.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus();
  }, [menuUid]);
  useEffect(() => {
    const saved = restoration.current;
    if (list.current) list.current.scrollTop = saved.scrollTop;
    const root: HTMLDivElement | null = panel.current;
    const row = (root ? Array.from(root.querySelectorAll<HTMLButtonElement>("[data-announcement-open]")) : []).find((element) => element.dataset.announcementOpen === saved.selectedUid);
    if (row) row.focus({ preventScroll: true });
    else focusPanelAction(root);
  }, []);
  useEffect(() => {
    if (!state.busy && document.activeElement === panel.current) focusPanelAction(panel.current);
  }, [state.busy]);
  useEffect(() => {
    const deleted = pendingDelete.current;
    if (!deleted || items.some((item) => item.uid === deleted.uid)) return;
    pendingDelete.current = null;
    const root: HTMLDivElement | null = panel.current;
    const rows = root ? Array.from(root.querySelectorAll<HTMLButtonElement>("[data-announcement-open]")) : [];
    const next = rows[Math.min(deleted.index, rows.length - 1)];
    if (next) next.focus({ preventScroll: true });
    else focusPanelAction(root);
  }, [items]);
  useEffect(() => {
    const outside = (event: Event) => { const target = event.target; if (target instanceof Node && !panel.current?.contains(target) && !anchor.contains(target)) closeHandler.current(false); };
    const keyboard = (event: KeyboardEvent) => {
      if (menuUid && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const root: HTMLDivElement | null = panel.current;
        const options = root ? Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menu"] button')) : [];
        if (options.length) {
          event.preventDefault(); event.stopImmediatePropagation();
          const current = options.findIndex((option) => option === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
          options[next].focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (menuUid) { setMenuUid(null); panel.current?.querySelector<HTMLButtonElement>(`[data-announcement-menu="${menuUid}"]`)?.focus(); }
        else closeHandler.current(true);
      }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("click", outside); document.addEventListener("focusin", outside); window.addEventListener("keydown", keyboard, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("click", outside); document.removeEventListener("focusin", outside); window.removeEventListener("keydown", keyboard, true); };
  }, [anchor, menuUid]);
  const error = state.error;
  return createPortal(<div ref={panel} role="dialog" tabIndex={-1} aria-label={t("announcements.title")} data-announcement-panel className="announcement-panel" style={position}>
    <header className="announcement-panel-header"><h2>{t("announcements.title")}</h2><div className="flex gap-1">
      <button type="button" data-announcement-mark-all title={t("announcements.markAll")} aria-label={t("announcements.markAll")} disabled={!items.length} onClick={() => { const uids = items.map((item) => item.uid); void state.controller.mutate(() => client.markAllRead(uids)); }}><CheckCheck className="h-4 w-4" /></button>
      <button type="button" title={t("announcements.reload")} aria-label={t("announcements.reload")} disabled={state.busy} onClick={() => void state.controller.refresh()}><RefreshCw className={`h-4 w-4 ${state.busy ? "animate-spin" : ""}`} /></button>
    </div></header>
    {error ? <p role="status" className="announcement-status">{t(`announcements.errors.${error}`, { defaultValue: t("announcements.errors.generic") })}</p> : null}
    {state.busy ? <p role="status" className="announcement-status">{t("announcements.loading")}</p> : null}
    <ul ref={list} className="announcement-list" onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
      {items.map((item) => {
        const content = i18n.language.startsWith("en") ? item.content.en ?? item.content.vi : item.content.vi;
        return <li key={item.uid} className="announcement-row" data-announcement-row={item.uid} data-announcement-read={!!item.readAt}>
          <button type="button" data-announcement-open={item.uid} disabled={articlePending} onClick={() => onOpen(item)} className="announcement-row-open">
            <Thumbnail item={item} feedHash={state.snapshot.feedHash ?? ""} client={client} />
            <span className="announcement-row-copy"><strong>{content.title}</strong><span>{content.summary}</span><time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString(i18n.language)}</time></span>
            {!item.readAt ? <span className="announcement-unread-dot" aria-label={t("announcements.unread")} /> : null}
          </button>
          <button type="button" className="announcement-row-menu-trigger" data-announcement-menu={item.uid} aria-label={t("announcements.actions")} aria-expanded={menuUid === item.uid} aria-haspopup="menu" onClick={() => setMenuUid((uid) => uid === item.uid ? null : item.uid)}><MoreHorizontal className="h-4 w-4" /></button>
          {menuUid === item.uid ? <div className="announcement-row-menu" role="menu">
            <button type="button" role="menuitem" data-announcement-toggle-read onClick={() => { setMenuUid(null); panel.current?.querySelector<HTMLButtonElement>(`[data-announcement-menu="${item.uid}"]`)?.focus(); void state.controller.mutate(() => client.setRead(item.uid, !item.readAt)); }}>{t(item.readAt ? "announcements.markUnread" : "announcements.markRead")}</button>
            <button type="button" role="menuitem" data-announcement-delete onClick={() => {
              pendingDelete.current = { uid: item.uid, index: items.findIndex((entry) => entry.uid === item.uid) }; setMenuUid(null);
              void state.controller.mutate(() => client.delete(item.uid)).then((success) => { if (!success) { pendingDelete.current = null; panel.current?.querySelector<HTMLButtonElement>(`[data-announcement-menu="${item.uid}"]`)?.focus(); } });
            }}>{t("announcements.delete")}</button>
          </div> : null}
        </li>;
      })}
    </ul>
    {!items.length && !state.busy ? <p className="announcement-status">{t("announcements.empty")}</p> : null}
    {state.snapshot.checkedAt ? <p className="announcement-panel-footer">{t("announcements.checked", { time: new Date(state.snapshot.checkedAt).toLocaleString(i18n.language) })}</p> : null}
  </div>, document.body);
}
