import assert from "node:assert/strict";
import test from "node:test";
import type { HostStatus } from "../../../shared/contracts.js";
import type { ToolchainState } from "./useToolchains.js";
import { createHostStatusRefresh } from "./host-status-refresh.js";

const idle = {
  discovery: { status: "complete", refreshing: false },
  manifestStatus: "ready", toolchains: [], profiles: [],
} as unknown as ToolchainState;
const ready = { gpp: { installed: true, submissionReady: true } } as HostStatus;

test("a queued refresh survives an earlier failed request and publishes the new host status", async () => {
  let failOld: ((error: Error) => void) | undefined;
  let calls = 0;
  const states: Array<HostStatus | null> = [];
  const errors: unknown[] = [];
  let scheduled: (() => Promise<void>) | undefined;
  const refresh = createHostStatusRefresh({
    loadToolchains: () => {
      calls += 1;
      return calls === 1
        ? new Promise<ToolchainState>((_resolve, reject) => { failOld = reject; })
        : Promise.resolve(idle);
    },
    loadHostStatus: async () => ready,
    onStatus: (status) => states.push(status),
    onError: (error) => errors.push(error),
    schedule: (run) => { scheduled = run; return () => { scheduled = undefined; }; },
  });
  const old = refresh.request();
  await Promise.resolve();
  const queued = refresh.request();
  assert.equal(queued, old);
  assert.ok(failOld);
  failOld(new Error("request A failed"));
  await old;
  assert.equal(errors.length, 1);
  assert.ok(scheduled, "request B must still be serviced after A fails");
  await scheduled();
  assert.equal(calls, 2);
  assert.equal(states.at(-1), ready);
  assert.equal(scheduled, undefined, "stable readiness stops background polling");
  refresh.dispose();
});

test("pending compiler selection updates automatically without flashing the host status to null", async () => {
  const pending = { ...idle, profiles: [{ active: { localProbe: { status: "checking" } } }] } as unknown as ToolchainState;
  const states: Array<HostStatus | null> = [];
  let calls = 0;
  let scheduled: (() => Promise<void>) | undefined;
  const refresh = createHostStatusRefresh({
    loadToolchains: async () => ++calls === 1 ? pending : idle,
    loadHostStatus: async () => calls === 1 ? { ...ready, gpp: { ...ready.gpp, submissionReady: false } } : ready,
    onStatus: (status) => states.push(status),
    onError: (error) => { throw error; },
    schedule: (run) => { scheduled = run; return () => { scheduled = undefined; }; },
  });
  await refresh.request();
  assert.ok(scheduled);
  await scheduled();
  assert.equal(states.at(-1), ready);
  assert.equal(states.filter((state) => state === null).length, 1);
  assert.equal(scheduled, undefined);
  refresh.dispose();
});

test("disposed refresh ownership cannot publish stale responses or schedule more polling", async () => {
  let resolveOld: ((status: HostStatus) => void) | undefined;
  const states: Array<HostStatus | null> = [];
  let schedules = 0;
  const refresh = createHostStatusRefresh({
    loadToolchains: async () => idle,
    loadHostStatus: () => new Promise<HostStatus>((resolve) => { resolveOld = resolve; }),
    onStatus: (status) => states.push(status),
    onError: (error) => { throw error; },
    schedule: () => { schedules += 1; return () => {}; },
  });
  const old = refresh.request();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(resolveOld);
  refresh.dispose();
  resolveOld(ready);
  await old;
  await refresh.request();
  assert.deepEqual(states, [null]);
  assert.equal(schedules, 0);
});

test("a transient host failure cannot stop polling a confirmed pending compiler", async () => {
  const pending = { ...idle, profiles: [{ active: { localProbe: { status: "checking" } } }] } as unknown as ToolchainState;
  const checkingHost = { ...ready, gpp: { ...ready.gpp, submissionReady: false } };
  const states: Array<HostStatus | null> = [];
  let calls = 0;
  let errors = 0;
  let scheduled: (() => Promise<void>) | undefined;
  const refresh = createHostStatusRefresh({
    loadToolchains: async () => ++calls < 3 ? pending : idle,
    loadHostStatus: async () => {
      if (calls === 2) throw new Error("transient host-status failure");
      return calls === 1 ? checkingHost : ready;
    },
    onStatus: (status) => states.push(status),
    onError: () => { errors += 1; },
    schedule: (run) => { scheduled = run; return () => { scheduled = undefined; }; },
  });
  await refresh.request();
  assert.ok(scheduled);
  await scheduled();
  assert.equal(errors, 1);
  assert.equal(states.at(-1), checkingHost);
  assert.ok(scheduled, "the confirmed pending compiler must still settle automatically");
  await scheduled();
  assert.equal(states.at(-1), ready);
  assert.equal(scheduled, undefined);
  refresh.dispose();
});
