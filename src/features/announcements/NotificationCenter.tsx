import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AnnouncementArticleView, AnnouncementPreview } from "../../../shared/announcements.js";
import { announcementClient, type AnnouncementClient } from "./announcement-client.js";
import { badge, visibleItems, pinnedArticleChanged } from "./announcement-model.js";
import { NotificationPopover } from "./NotificationPopover.js";
import type { useAnnouncements } from "./useAnnouncements.js";
import { AnnouncementBoundary } from "./AnnouncementBoundary.js";
const ArticleModal = lazy(() => import("./NotificationArticleModal.js"));

export function NotificationCenter({ state, client = announcementClient, blocked, onModalChange }: {
  state: ReturnType<typeof useAnnouncements>; client?: AnnouncementClient; blocked: boolean; onModalChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLButtonElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [view, setView] = useState<AnnouncementArticleView | null>(null);
  const [articlePending, setArticlePending] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [clock, setClock] = useState(() => new Date().toISOString());
  const renderedView = useRef<string | null>(null);
  const pending = useRef(false); const generation = useRef(0);
  const currentView = useRef(view); currentView.current = view;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString());
    const timer = window.setInterval(tick, 60_000); window.addEventListener("focus", tick); document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, []);
  useEffect(() => {
    if (blocked) { setPanelOpen(false); setView(null); ++generation.current; }
  }, [blocked]);
  useEffect(() => { onModalChange(!!view || articlePending); }, [view, articlePending, onModalChange]);
  useEffect(() => {
    if (!view) return;
    return () => { void client.closeArticle(view.viewId).catch(state.controller.reportError); };
  }, [view, client, state.controller]);
  useEffect(() => () => { ++generation.current; }, []);
  const items = visibleItems(state.snapshot, clock);
  const unread = items.filter((item) => !item.readAt).length;
  const openArticle = async (item: AnnouncementPreview) => {
    if (pending.current || blockedRef.current || !state.snapshot.feedHash) return;
    pending.current = true; setArticlePending(true); const request = ++generation.current;
    try {
      const article = await client.openArticle(item.uid, state.snapshot.feedHash);
      if (request !== generation.current || blockedRef.current) { await client.closeArticle(article.viewId); return; }
      setSelectedUid(item.uid); setPanelOpen(false); setView(article);
    } catch (error) {
      state.controller.reportError(error);
      if (String(error).includes("staleSnapshot")) void state.controller.refresh();
    } finally { pending.current = false; setArticlePending(false); }
  };
  const closeArticle = useCallback(() => {
    setView(null);
    if (!blockedRef.current) setPanelOpen(true);
  }, []);
  const markRendered = useCallback(() => {
    const article = currentView.current;
    if (!article || renderedView.current === article.viewId) return;
    renderedView.current = article.viewId;
    void state.controller.mutate(() => client.setRead(article.item.uid, true));
  }, [client, state.controller]);
  const closePanel = useCallback((restoreFocus: boolean) => { ++generation.current; setPanelOpen(false); if (restoreFocus) anchor.current?.focus(); }, []);
  return <>
    <button ref={anchor} type="button" data-announcement-bell disabled={blocked} className="announcement-bell" aria-label={t("announcements.bell", { count: unread })} title={t("announcements.title")} aria-haspopup="dialog" aria-expanded={panelOpen} onClick={() => {
      if (!panelOpen) { setClock(new Date().toISOString()); state.controller.refreshIfStale(); }
      setPanelOpen((open) => !open);
    }}><Bell className="h-4 w-4" aria-hidden="true" />{unread > 0 ? <span data-announcement-badge aria-hidden="true" className="announcement-badge">{badge(unread)}</span> : null}</button>
    {panelOpen && anchor.current && !blocked ? <NotificationPopover anchor={anchor.current} state={state} items={items} client={client} articlePending={articlePending} scrollTop={scrollTop} selectedUid={selectedUid} onScroll={setScrollTop} onClose={closePanel} onOpen={(item) => void openArticle(item)} /> : null}
    {view && !blocked ? <AnnouncementBoundary onError={state.controller.reportError} onClose={closeArticle}><Suspense fallback={<div role="status" className="announcement-loading">{t("announcements.loading")}</div>}><ArticleModal view={view} client={client} changed={pinnedArticleChanged(view, state.snapshot, clock)} error={state.error} onClose={closeArticle} onRendered={markRendered} onError={state.controller.reportError} /></Suspense></AnnouncementBoundary> : null}
  </>;
}
