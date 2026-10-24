import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AnnouncementArticleView } from "../../../shared/announcements.js";
import type { AnnouncementClient } from "./announcement-client.js";
import { AnnouncementArticle } from "./AnnouncementArticle.js";

export default function NotificationArticleModal({ view, client, changed, error, onClose, onRendered, onError }: {
  view: AnnouncementArticleView; client: AnnouncementClient; changed: boolean; error: string | null;
  onClose: () => void; onRendered: () => void; onError: (error: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const overlay = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose); closeHandler.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const siblings = Array.from(document.body.children).filter((element) => element !== overlay.current);
    const states = siblings.map((element) => [element, element.getAttribute("inert")] as const);
    for (const element of siblings) element.setAttribute("inert", "");
    close.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeHandler.current(); return; }
      if (event.key !== "Tab") return;
      const root: HTMLDivElement | null = overlay.current;
      const targets = (root ? Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex="0"]')) : []).filter((element) => !element.hidden);
      const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const focus = (event: FocusEvent) => { if (!overlay.current?.contains(event.target as Node)) close.current?.focus(); };
    window.addEventListener("keydown", keyboard, true); document.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", keyboard, true); document.removeEventListener("focusin", focus);
      for (const [element, state] of states) { if (state === null) element.removeAttribute("inert"); else element.setAttribute("inert", state); }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const content = i18n.language.startsWith("en") ? view.item.content.en ?? view.item.content.vi : view.item.content.vi;
  return createPortal(<div ref={overlay} className="announcement-modal-overlay" data-announcement-modal-root>
    <section className="announcement-modal" role="dialog" aria-modal="true" aria-labelledby="announcement-article-title">
      <header className="announcement-modal-header"><h2 id="announcement-article-title">{content.title}</h2><button ref={close} type="button" onClick={onClose} aria-label={t("common.close")}><X className="h-5 w-5" /></button></header>
      <div className="announcement-modal-scroll">
        <time dateTime={view.item.publishedAt} className="text-xs text-text-muted">{new Date(view.item.publishedAt).toLocaleString(i18n.language)}</time>
        {changed ? <p className="announcement-status">{t("announcements.articleChanged")}</p> : null}
        {error ? <p role="status" className="announcement-status">{t(`announcements.errors.${error}`, { defaultValue: t("announcements.errors.generic") })}</p> : null}
        <AnnouncementArticle view={view} client={client} onRendered={onRendered} onError={onError} />
      </div>
    </section>
  </div>, document.body);
}
