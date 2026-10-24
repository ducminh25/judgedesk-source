import React, { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ANNOUNCEMENT_HTML_TAGS } from "../../../shared/announcement-html-policy.js";
import type { AnnouncementArticleView, AnnouncementImage } from "../../../shared/announcements.js";
import type { AnnouncementClient } from "./announcement-client.js";
import { sanitizeArticle } from "./sanitize-article.js";
import { AnnouncementMedia } from "./AnnouncementMedia.js";

function ArticleImage({ image, alt, viewId, client }: { image: AnnouncementImage; alt: string; viewId: string; client: AnnouncementClient }) {
  const load = useCallback(() => client.image(viewId, image.id), [client, viewId, image.id]);
  return <AnnouncementMedia image={image} alt={alt} load={load} />;
}
const layouts: Record<string, string> = { wide: "announcement-wide", "align-left": "text-left", "align-center": "text-center", "align-right": "text-right" };

export function AnnouncementArticle({ view, client, onRendered, onError }: {
  view: AnnouncementArticleView; client: AnnouncementClient; onRendered: () => void; onError: (error: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const html = (i18n.language.startsWith("en") ? view.item.content.en ?? view.item.content.vi : view.item.content.vi).html;
  const rendered = useMemo(() => {
    try {
      const fragment = sanitizeArticle(window, html, { imageIds: view.item.images.filter((image) => image.role === "article").map((image) => image.id), linkIds: view.item.links.map((link) => link.id) });
      if (!fragment.textContent?.trim()) throw new Error("article");
      const render = (node: Node, key: string): React.ReactNode => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1) return null;
        const element = node as Element;
        const tag = element.tagName.toLowerCase();
        if (!ANNOUNCEMENT_HTML_TAGS.some((allowed) => allowed === tag)) return null;
        const children = Array.from(node.childNodes).map((child, index) => render(child, `${key}-${index}`));
        const title = element.getAttribute("title") ?? undefined;
        if (tag === "img") {
          const image = view.item.images.find((image) => image.id === element.getAttribute("data-announcement-image") && image.role === "article");
          return image ? <React.Fragment key={key}><ArticleImage image={image} alt={element.getAttribute("alt") ?? ""} viewId={view.viewId} client={client} /></React.Fragment> : null;
        }
        if (tag === "a") {
          const id = element.getAttribute("data-announcement-link");
          return id ? <button key={key} type="button" role="link" title={title} className="announcement-link" onClick={() => { void client.openLink(view.viewId, id).catch(onError); }}>{children}</button> : <span key={key}>{children}</span>;
        }
        const className = element.className.split(/\s+/).map((value) => layouts[value]).filter(Boolean).join(" ") || undefined;
        return React.createElement(tag, { key, className, title }, tag === "br" || tag === "hr" ? undefined : children);
      };
      return { nodes: Array.from(fragment.childNodes).map((node, index) => render(node, String(index))), error: false };
    } catch { return { nodes: null, error: true }; }
  }, [html, view, client, onError]);
  useEffect(() => { if (!rendered.error) onRendered(); }, [rendered.error, onRendered]);
  return rendered.error ? <p role="alert">{t("announcements.articleError")}</p> : <div className="announcement-article">{rendered.nodes}</div>;
}
