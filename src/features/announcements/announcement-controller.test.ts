import assert from "node:assert/strict";
import { test } from "node:test";
import { AnnouncementController } from "./announcement-controller.js";
import type { AnnouncementClient } from "./announcement-client.js";
import type { AnnouncementSnapshot } from "../../../shared/announcements.js";
const snapshot = (localRevision: number): AnnouncementSnapshot => ({ localRevision, feedHash: null, sequence: null, checkedAt: null, items: [] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("controller starts once across subscriptions, shows cache before network, and retains cache on failure", async () => {
  const network = deferred<AnnouncementSnapshot>(); let starts = 0; let fetches = 0;
  const client: Pick<AnnouncementClient, "snapshot" | "refresh"> = { snapshot: async () => { ++starts; return snapshot(1); }, refresh: async () => { ++fetches; return network.promise; } };
  const controller = new AnnouncementController(client);
  const first = controller.start(); const second = controller.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().snapshot.localRevision, 1);
  network.reject(new Error("offline")); await Promise.all([first, second]);
  assert.equal(starts, 1); assert.equal(fetches, 1);
  assert.equal(controller.getState().snapshot.localRevision, 1);
  assert.equal(controller.getState().error, "offline");
  assert.equal(controller.getState().busy, false);
});
test("out-of-order refresh cannot overwrite committed mutation state", async () => {
  const late = deferred<AnnouncementSnapshot>();
  const controller = new AnnouncementController({ snapshot: async () => snapshot(0), refresh: async () => late.promise });
  const pending = controller.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await controller.mutate(async () => snapshot(4));
  late.resolve(snapshot(2)); await pending;
  assert.equal(controller.getState().snapshot.localRevision, 4);
});
