import { executorClient } from "../executor/client.js";
import type { ExecutorRunResult, ExecutorRunSpec } from "../executor/protocol.js";
import { isExecutorRunReason } from "../executor/protocol.js";
import { LocalProbeCleanupUnconfirmedError } from "./local-probe-registry.js";

/** Await ordered submission and native drain; an abort signal is not drain proof. */
export async function runLocalProbePhase(
  spec: ExecutorRunSpec,
  signal?: AbortSignal,
): Promise<ExecutorRunResult> {
  let submitted = false;
  let cancellation: Promise<boolean> | undefined;
  let result: ExecutorRunResult | undefined;
  let failure: { error: unknown } | undefined;
  const requestCancel = () => {
    if (submitted && !cancellation) {
      cancellation = executorClient.cancel(spec.runId).catch(() => false);
    }
  };
  signal?.addEventListener("abort", requestCancel, { once: true });
  try {
    try {
      result = await executorClient.run(spec, () => {
        // This check and the client's ordered pipe write share one JS turn.
        if (signal?.aborted) throw new Error("Compatibility probe aborted");
        submitted = true;
      });
    } catch (error: unknown) {
      failure = { error };
    }
    // Windows may emit internal_error while a Job Object still has processes.
    const terminalDrain = result !== undefined && isExecutorRunReason(result.reason) && result.reason !== "internal_error";
    if (submitted && !terminalDrain) requestCancel();
    const cancelDrain = cancellation ? await cancellation : false;
    if (submitted && !terminalDrain && !cancelDrain) {
      throw new LocalProbeCleanupUnconfirmedError(`${spec.role} run ${spec.runId} has no confirmed drain`);
    }
    if (signal?.aborted) throw new Error("Compatibility probe aborted");
    if (failure) throw failure.error;
    if (!result) throw new Error("Local compatibility probe has no native result");
    if (!isExecutorRunReason(result.reason)) throw new Error("Local compatibility probe received an invalid native result reason");
    return result;
  } finally {
    signal?.removeEventListener("abort", requestCancel);
  }
}
