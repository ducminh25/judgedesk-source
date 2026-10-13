import assert from "node:assert/strict";
import test from "node:test";
import { executorClient } from "../executor/client.js";
import { buildSubmissionExecutorRunSpec } from "../judge/execution-request.js";
import type { ExecutorRunResult } from "../executor/protocol.js";
import { LocalProbeCleanupUnconfirmedError } from "./local-probe-registry.js";
import { runLocalProbePhase } from "./local-probe-run.js";

test("missing and unknown native result reasons cannot prove local probe drain", async (t) => {
  for (const reason of [undefined, "future_or_corrupt_reason"]) {
    await t.test(String(reason), async (child) => {
      const spec = buildSubmissionExecutorRunSpec({
        runId: "invalid-reason", workspaceId: "owned-workspace", executableId: "owned-program",
        args: [], environment: {}, timeLimitMs: 100, memoryBytes: 64 * 1024 * 1024,
      });
      let cancels = 0;
      child.mock.method(executorClient, "run", async (_spec, beforeSubmit?: () => void) => {
        beforeSubmit?.();
        // Simulate unvalidated external IPC, intentionally outside the TS union.
        return { runId: spec.runId, reason } as unknown as ExecutorRunResult;
      });
      child.mock.method(executorClient, "cancel", async () => { cancels += 1; return false; });
      await assert.rejects(runLocalProbePhase(spec), LocalProbeCleanupUnconfirmedError);
      assert.equal(cancels, 1);
    });
  }
});
