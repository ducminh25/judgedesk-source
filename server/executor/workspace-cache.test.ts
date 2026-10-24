import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executorClient } from "./client.js";
import { purgeCachedManagedToolchain } from "./workspace.js";

test("Linux cache purge is harmless before the first managed import", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-empty-managed-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, "platform", () => "linux");
  t.mock.method(os, "arch", () => "x64");
  t.mock.method(executorClient, "start", async () => ({
    ready: true, mode: "linux-bwrap-cgroup-seccomp", executorVersion: "1.6.0",
    executorRoot: root, diagnostics: [], networkBlocked: true,
    filesystemIsolated: true, processTreeControlled: true, memoryLimitSupported: true,
  }));
  await purgeCachedManagedToolchain("python");
  assert.deepEqual(fs.readdirSync(root), []);
});
