/** Data-only policy consumed independently by the publisher and WebView renderer. */
export const ANNOUNCEMENT_HTML_TAGS = [
  "p", "h2", "h3", "h4", "strong", "em", "ul", "ol", "li", "blockquote",
  "pre", "code", "a", "figure", "figcaption", "img", "br", "hr", "div", "span",
] as const;
export const ANNOUNCEMENT_HTML_ATTRIBUTES = [
  "alt", "title", "class", "data-announcement-image", "data-announcement-link",
] as const;
export const ANNOUNCEMENT_LAYOUT_CLASSES = ["wide", "align-left", "align-center", "align-right"] as const;
export const ANNOUNCEMENT_HTML_LIMITS = { bytes: 64 * 1024, nodes: 5000, depth: 32, images: 8 } as const;
