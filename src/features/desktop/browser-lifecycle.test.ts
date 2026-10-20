import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BACKEND_TRANSIENT_RETRY_WINDOW_MS,
  fetchWithStartupRetry,
  isDesktopReloadShortcut,
  resolveApiRetryDeadline,
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

test("resolveApiRetryDeadline provides a bounded transient retry window after the startup deadline expires", async () => {
  const expiredStartupDeadline = 15_000;
  let clock = 60_000;
  const deadline = resolveApiRetryDeadline(expiredStartupDeadline, clock);
  assert.equal(deadline, clock + BACKEND_TRANSIENT_RETRY_WINDOW_MS);

  let attempts = 0;
  const response = await fetchWithStartupRetry("http://127.0.0.1/api/toolchains", undefined, {
    deadline,
    now: () => clock,
    pause: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(await response.json(), { ok: true });
});

test("fetchWithStartupRetry still retries when a stalled socket rejects after the initial deadline window", async () => {
  let clock = 10_000;
  const deadline = resolveApiRetryDeadline(0, clock);
  let attempts = 0;
  const response = await fetchWithStartupRetry("http://127.0.0.1/api/toolchains/profiles/cpp-legacy-v1/preference", undefined, {
    deadline,
    now: () => clock,
    pause: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        // Simulate Chromium WebView2 taking 15s to reject a stalled loopback socket
        clock += 15_000;
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ success: true }));
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(await response.json(), { success: true });
});
