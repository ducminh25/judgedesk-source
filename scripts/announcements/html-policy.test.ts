import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sanitizeArticle } from "../../src/features/announcements/sanitize-article.js";
import { sanitizeSource } from "./sanitize-source.js";

test("HTML policy keeps article structure and only manifest-bound resource references", () => {
  const dom = new JSDOM();
  const result = sanitizeArticle(dom.window, '<p id="x" style="color:red" onclick="bad()">A<strong>B</strong></p><figure class="wide evil"><img src="https://evil.test/a" data-announcement-image="photo" alt="Example"><figcaption>C</figcaption></figure><a href="javascript:bad()" data-announcement-link="guide" target="_blank">D</a>', { imageIds: ["photo"], linkIds: ["guide"] });
  const container = dom.window.document.createElement("div");
  container.append(result);
  assert.equal(container.textContent, "ABCD");
  assert.equal(container.querySelector("img")?.getAttribute("data-announcement-image"), "photo");
  assert.equal(container.querySelector("a")?.getAttribute("data-announcement-link"), "guide");
  assert.equal(container.querySelector("figure")?.className, "wide");
  assert.equal(container.querySelector("[src],[href],[style],[id],[onclick],[target]"), null);
  dom.window.close();
});

test("HTML policy blocks foreign namespaces, clobbering, controls, unknown IDs and mXSS", () => {
  const dom = new JSDOM();
  for (const html of [
    '<svg><g onload="bad()"/></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=bad()>">',
    '<form id="attributes"><input name="__proto__" autofocus><button>bad</button></form><iframe srcdoc="bad"></iframe>',
    '<img data-announcement-image="missing" src="file:///secret"><a data-announcement-link="missing" href="data:text/html,bad">text</a>',
    '<div tabindex="0" contenteditable="true" data-evil="true" aria-hidden="true"><script>bad()</script><style>*{display:none}</style>ok</div>',
  ]) {
    const fragment = sanitizeArticle(dom.window, html, { imageIds: [], linkIds: [] });
    for (const el of fragment.querySelectorAll("*")) {
      assert.equal(el.namespaceURI, "http://www.w3.org/1999/xhtml");
      assert.ok(!["SCRIPT", "STYLE", "SVG", "MATH", "FORM", "INPUT", "BUTTON", "IFRAME"].includes(el.tagName));
      for (const attribute of el.attributes) assert.ok(["alt", "title", "class"].includes(attribute.name), attribute.name);
    }
    assert.equal(fragment.querySelector("img"), null);
  }
  dom.window.close();
});

test("HTML limits reject bytes, excessive nodes and depth before rendering", () => {
  const dom = new JSDOM();
  for (const html of ["x".repeat(65537), "<br>".repeat(5001), "<div>".repeat(33) + "deep" + "</div>".repeat(33)]) {
    assert.throws(() => sanitizeArticle(dom.window, html, { imageIds: [], linkIds: [] }), /limit/i);
  }
  dom.window.close();
});

test("repeated image references cannot create thousands of native image requests", () => {
  const dom = new JSDOM();
  const html = '<p>Text</p>' + '<img data-announcement-image="photo" alt="photo">'.repeat(9);
  try {
    assert.throws(() => sanitizeArticle(dom.window, html, { imageIds: ["photo"], linkIds: [] }), /image.*limit/i);
    assert.throws(() => sanitizeSource(html, [{ id: "photo", sha256: "a".repeat(64), sizeBytes: 1, role: "article", mime: "image/png", extension: "png" }], []), /image.*limit/i);
  } finally { dom.window.close(); }
});
