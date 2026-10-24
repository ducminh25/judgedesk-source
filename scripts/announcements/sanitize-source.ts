import { createHash } from "node:crypto";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { ANNOUNCEMENT_HTML_TAGS, ANNOUNCEMENT_HTML_ATTRIBUTES, ANNOUNCEMENT_LAYOUT_CLASSES, ANNOUNCEMENT_HTML_LIMITS } from "../../shared/announcement-html-policy.js";
import type { AnnouncementImage, AnnouncementLink } from "../../shared/announcements.js";
import { assertAnnouncementLink } from "./validate-payload.js";

export function sanitizeSource(html: string, images: AnnouncementImage[], links: AnnouncementLink[]): string {
  if (Buffer.byteLength(html, "utf8") > ANNOUNCEMENT_HTML_LIMITS.bytes) throw new Error("Author HTML byte limit exceeded");
  const dom = new JSDOM("", { url: "https://announcements.invalid/" });
  try {
    const fragment = createDOMPurify(dom.window).sanitize(html, {
      ALLOWED_TAGS: [...ANNOUNCEMENT_HTML_TAGS], ALLOWED_ATTR: [...ANNOUNCEMENT_HTML_ATTRIBUTES, "href"],
      ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
    });
    let count = 0; let imageNodes = 0;
    const visit = (node: Node, depth: number): void => {
      if (++count > ANNOUNCEMENT_HTML_LIMITS.nodes || depth > ANNOUNCEMENT_HTML_LIMITS.depth) throw new Error("Author HTML node/depth limit exceeded");
      if (node.nodeType === 1) {
        const element = node as Element;
        if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") { element.remove(); return; }
        const classes = element.className.split(/\s+/).filter((value) => ANNOUNCEMENT_LAYOUT_CLASSES.some((allowed) => allowed === value));
        element.removeAttribute("class"); if (classes.length) element.setAttribute("class", classes.join(" "));
        element.removeAttribute("data-announcement-link");
        const image = element.getAttribute("data-announcement-image"); element.removeAttribute("data-announcement-image");
        if (element.tagName === "IMG") {
          if (++imageNodes > ANNOUNCEMENT_HTML_LIMITS.images) throw new Error("Author image limit exceeded");
          if (!image || !images.some((entry) => entry.id === image && entry.role === "article")) throw new Error("Author image reference is outside the article manifest");
          element.setAttribute("data-announcement-image", image);
        }
        const href = element.getAttribute("href"); element.removeAttribute("href");
        if (element.tagName === "A" && href) {
          assertAnnouncementLink(href);
          let link = links.find((link) => link.url === href);
          if (!link) { link = { id: `link-${createHash("sha256").update(href).digest("hex").slice(0, 24)}`, url: href }; links.push(link); }
          element.setAttribute("data-announcement-link", link.id);
        }
      }
      for (const child of Array.from(node.childNodes)) visit(child, depth + 1);
    };
    for (const child of Array.from(fragment.childNodes)) visit(child, 1);
    if (!fragment.textContent?.trim()) throw new Error("Article must contain readable text after sanitization");
    const container = dom.window.document.createElement("div"); container.append(fragment); return container.innerHTML;
  } finally { dom.window.close(); }
}
