import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  fetchWithStartupRetry,
  isDesktopReloadShortcut,
  shouldRegisterBrowserBeforeUnload,
} from "./browser-lifecycle.js";

test("Tauri uses its native close handler instead of Chromium beforeunload", () => {
  assert.equal(shouldRegisterBrowserBeforeUnload({ __TAURI_INTERNALS__: {} }), false);
  assert.equal(shouldRegisterBrowserBeforeUnload({}), true);
});

test("desktop reload shortcuts are blocked without interfering with Alt+Tab", () => {
  assert.equal(isDesktopReloadShortcut({ key: "F5", ctrlKey: false, metaKey: false }), true);
  assert.equal(isDesktopReloadShortcut({ key: "r", ctrlKey: true, metaKey: false }), true);
  assert.equal(isDesktopReloadShortcut({ key: "R", ctrlKey: false, metaKey: true }), true);
  assert.equal(isDesktopReloadShortcut({ key: "Tab", ctrlKey: false, metaKey: false }), false);
});

test("desktop manual testing disables Vite HMR reloads", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.match(packageJson.scripts["test:desktop"], /DISABLE_HMR=true\s+tauri dev --no-watch/);
});

test("desktop startup retries connection refusal until the backend is listening", async () => {
  let attempts = 0;
  let clock = 0;
  const response = await fetchWithStartupRetry("http://127.0.0.1/status", undefined, {
    deadline: 1_000,
    now: () => clock,
    pause: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("fetch failed");
      return new Response("ok");
    },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(attempts, 3);
});

test("desktop startup surfaces a persistent backend failure after the deadline", async () => {
  await assert.rejects(
    fetchWithStartupRetry("http://127.0.0.1/status", undefined, {
      deadline: 0,
      now: () => 0,
      fetchImpl: async () => { throw new TypeError("fetch failed"); },
    }),
    /fetch failed/,
  );
});
