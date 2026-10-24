import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en.json";
import { NotificationCenter } from "./NotificationCenter.js";
import { AnnouncementController } from "./announcement-controller.js";
import { useAnnouncements } from "./useAnnouncements.js";
import type { AnnouncementClient } from "./announcement-client.js";
import type { AnnouncementSnapshot } from "../../../shared/announcements.js";

test("bell never auto-opens, opening panel does not read, menu supports unread/delete and captured mark-all", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://desktop.invalid/" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const i18n = createInstance(); await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  let snapshot: AnnouncementSnapshot = { localRevision: 1, feedHash: "a".repeat(64), sequence: 1, checkedAt: new Date().toISOString(), items: [
    { uid: "test", revision: 1, publishedAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z", content: { vi: { title: "Tin mới", summary: "Nội dung" } }, readAt: null, deleted: false },
  ] };
  let reads = 0; let marked: string[] = [];
  const update = (read: boolean, deleted = false) => { snapshot = { ...snapshot, localRevision: snapshot.localRevision + 1, items: snapshot.items.map((item) => ({ ...item, readAt: read ? new Date().toISOString() : null, deleted })) }; return snapshot; };
  const client: AnnouncementClient = {
    snapshot: async () => snapshot, refresh: async () => snapshot,
    setRead: async (_uid, read) => { ++reads; return update(read); },
    markAllRead: async (uids) => { marked = uids; return update(true); }, delete: async () => update(false, true),
    openArticle: async () => ({ viewId: "test-view", feedHash: snapshot.feedHash!, item: {
      uid: "test", revision: 1, publishedAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
      content: { vi: { title: "Tin mới", summary: "Nội dung", html: '<p>Nội dung <strong>chi tiết</strong>.</p><script>bad()</script>' } }, images: [], links: [],
    } }), closeArticle: async () => {},
    image: async () => new ArrayBuffer(0), thumbnail: async () => new ArrayBuffer(0), openLink: async () => {},
  };
  const controller = new AnnouncementController(client);
  function Harness() { const state = useAnnouncements(controller); return <NotificationCenter state={state} client={client} blocked={false} onModalChange={() => {}} />; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const click = async (selector: string) => { const element = dom.window.document.querySelector<HTMLElement>(selector); assert.ok(element, selector); await act(async () => { element.click(); }); };
  try {
    await act(async () => { root.render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>); await controller.start(); });
    assert.equal(dom.window.document.querySelector('[data-announcement-panel]'), null);
    await click('[data-announcement-bell]'); assert.equal(reads, 0);
    const row = dom.window.document.querySelector<HTMLButtonElement>('[data-announcement-open="test"]')!;
    const list = dom.window.document.querySelector<HTMLUListElement>('.announcement-list')!;
    row.focus();
    await act(async () => { list.scrollTop = 25; list.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })); });
    assert.equal(dom.window.document.activeElement === row, true, "scrolling must not steal keyboard focus");
    await import("./NotificationArticleModal.js");
    await click('[data-announcement-open="test"]');
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.ok(dom.window.document.querySelector('[data-announcement-modal-root]'));
    assert.ok(dom.window.document.querySelector('.announcement-article strong'));
    assert.equal(dom.window.document.querySelector('.announcement-article script'), null);
    assert.equal(reads, 1);
    assert.ok(dom.window.document.getElementById("root")?.hasAttribute("inert"));
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(dom.window.document.querySelector('[data-announcement-modal-root]'), null);
    assert.equal(dom.window.document.getElementById("root")?.hasAttribute("inert"), false);
    await click('[data-announcement-menu="test"]'); await click('[data-announcement-toggle-read]'); assert.equal(reads, 2);
    assert.ok(dom.window.document.querySelector('[data-announcement-read="false"]'));
    await click('[data-announcement-mark-all]'); assert.deepEqual(marked, ["test"]);
    await click('[data-announcement-menu="test"]'); await click('[data-announcement-delete]');
    assert.equal(dom.window.document.querySelector('[data-announcement-row="test"]'), null);
    assert.equal(dom.window.document.querySelector('[data-announcement-badge]'), null);
    assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Reload", "deleting the last row focuses an enabled header action");
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    snapshot = { ...snapshot, localRevision: snapshot.localRevision + 1, checkedAt: null };
    await act(async () => { await controller.mutate(async () => snapshot); });
    let finishRefresh: ((value: AnnouncementSnapshot) => void) | undefined;
    client.refresh = () => new Promise((resolve) => { finishRefresh = resolve; });
    await click('[data-announcement-bell]');
    assert.equal(dom.window.document.activeElement?.hasAttribute("data-announcement-panel"), true, "empty loading panel receives focus while header actions are disabled");
    assert.ok(finishRefresh);
    await act(async () => { finishRefresh?.(snapshot); });
    assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Reload", "initial loading completion focuses an enabled action");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
