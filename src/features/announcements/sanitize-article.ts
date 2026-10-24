import createDOMPurify, { type WindowLike } from "dompurify";
import {
  ANNOUNCEMENT_HTML_TAGS, ANNOUNCEMENT_HTML_ATTRIBUTES,
  ANNOUNCEMENT_LAYOUT_CLASSES, ANNOUNCEMENT_HTML_LIMITS,
} from "../../../shared/announcement-html-policy.js";

export interface ArticleReferences { imageIds: readonly string[]; linkIds: readonly string[] }

/** Never serialize/reparse the returned fragment; render selected nodes/props directly. */
export function sanitizeArticle(window: WindowLike, html: string, references: ArticleReferences): DocumentFragment {
  if (new TextEncoder().encode(html).byteLength > ANNOUNCEMENT_HTML_LIMITS.bytes) throw new Error("Article byte limit exceeded");
  const fragment = createDOMPurify(window).sanitize(html, {
    ALLOWED_TAGS: [...ANNOUNCEMENT_HTML_TAGS],
    ALLOWED_ATTR: [...ANNOUNCEMENT_HTML_ATTRIBUTES],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true, SANITIZE_DOM: true,
  });
  let nodes = 0; let imageNodes = 0;
  const visit = (node: Node, depth: number): void => {
    if (++nodes > ANNOUNCEMENT_HTML_LIMITS.nodes || depth > ANNOUNCEMENT_HTML_LIMITS.depth) throw new Error("Article node/depth limit exceeded");
    if (node.nodeType === 1) {
      // Node constructors belong to the caller's DOM (jsdom/WebView may be different realms).
      const element = node as Element;
      if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") { element.remove(); return; }
      const classes = element.className.split(/\s+/).filter((value) => ANNOUNCEMENT_LAYOUT_CLASSES.some((allowed) => allowed === value));
      element.removeAttribute("class");
      if (classes.length) element.setAttribute("class", classes.join(" "));
      const image = element.getAttribute("data-announcement-image");
      const link = element.getAttribute("data-announcement-link");
      element.removeAttribute("data-announcement-image");
      element.removeAttribute("data-announcement-link");
      if (element.tagName === "IMG") {
        if (++imageNodes > ANNOUNCEMENT_HTML_LIMITS.images) throw new Error("Article image limit exceeded");
        if (!image || !references.imageIds.includes(image)) { element.remove(); return; }
        element.setAttribute("data-announcement-image", image);
      }
      if (element.tagName === "A" && link && references.linkIds.includes(link)) element.setAttribute("data-announcement-link", link);
    }
    for (const child of Array.from(node.childNodes)) visit(child, depth + 1);
  };
  for (const child of Array.from(fragment.childNodes)) visit(child, 1);
  return fragment;
}
