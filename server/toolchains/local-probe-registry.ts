import type {
  DerivedLocalToolchain,
  LocalCompatibilityProbeRunner,
  LocallyExecutableKind,
} from "./local-execution.js";

export type LocalCompatibilityProbeStatus = "not_started" | "checking" | "compatible" | "incompatible";

export interface LocalCompatibilityProbeSnapshot {
  status: LocalCompatibilityProbeStatus;
  checkedAt?: string;
  diagnostic?: string;
}

export class LocalProbeCleanupUnconfirmedError extends Error {
  constructor(detail: string) {
    super(`cleanup-unconfirmed: ${detail}`);
    this.name = "LocalProbeCleanupUnconfirmedError";
  }
}

export function localProbeFailureSnapshot(error: unknown): LocalCompatibilityProbeSnapshot {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "incompatible",
    checkedAt: new Date().toISOString(),
    diagnostic: message.length <= 320 ? message : `${message.slice(0, 317)}...`,
  };
}

interface OwnedProbe {
  controller: AbortController;
  promise: Promise<LocalCompatibilityProbeSnapshot>;
  callerListeners: Map<AbortSignal, () => void>;
  retainedFailure?: LocalCompatibilityProbeSnapshot;
  settled: boolean;
}

/** Admission invalidation never releases native-operation ownership. */
export function createLocalProbeRegistry() {
  const admission = new Map<string, LocalCompatibilityProbeSnapshot>();
  const operations = new Map<string, OwnedProbe>();
  let generation = 0;
  let closing = false;

  const operationKey = (kind: LocallyExecutableKind, derived: DerivedLocalToolchain) =>
    `${kind}\0${process.platform === "win32" ? derived.executablePath.toLowerCase() : derived.executablePath}`;
  const join = (operation: OwnedProbe, signal?: AbortSignal) => {
    if (!signal || operation.settled || operation.callerListeners.has(signal)) return;
    const onAbort = () => operation.controller.abort();
    operation.callerListeners.set(signal, onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  };
  const cancel = () => {
    for (const operation of operations.values()) operation.controller.abort();
  };

  return {
    get(kind: LocallyExecutableKind, derived: DerivedLocalToolchain): LocalCompatibilityProbeSnapshot | undefined {
      const operation = operations.get(operationKey(kind, derived));
      if (operation?.retainedFailure) return operation.retainedFailure;
      if (closing) return localProbeFailureSnapshot(new Error("Compatibility probes are stopping"));
      return admission.get(derived.fingerprint) || (operation ? { status: "checking" } : undefined);
    },
    clear(): void {
      generation += 1;
      admission.clear();
    },
    schedule(
      kind: LocallyExecutableKind,
      derived: DerivedLocalToolchain,
      runner: LocalCompatibilityProbeRunner,
      signal?: AbortSignal,
    ): Promise<LocalCompatibilityProbeSnapshot> {
      if (closing || signal?.aborted) {
        return Promise.resolve(localProbeFailureSnapshot(
          new Error(closing ? "Compatibility probes are stopping" : "Compatibility probe aborted"),
        ));
      }
      const key = operationKey(kind, derived);
      const existing = operations.get(key);
      if (existing) {
        join(existing, signal);
        return existing.promise;
      }
      const cached = admission.get(derived.fingerprint);
      if (cached) return Promise.resolve(cached);

      const startedGeneration = generation;
      const controller = new AbortController();
      let operation: OwnedProbe;
      const promise: Promise<LocalCompatibilityProbeSnapshot> = Promise.resolve()
        .then(async () => {
          if (controller.signal.aborted) throw new Error("Compatibility probe aborted");
          await runner(kind, derived, controller.signal);
          if (controller.signal.aborted) throw new Error("Compatibility probe aborted");
          return { status: "compatible" as const, checkedAt: new Date().toISOString() };
        })
        .catch((error: unknown) => {
          const failure = localProbeFailureSnapshot(error);
          if (error instanceof LocalProbeCleanupUnconfirmedError) {
            operation.retainedFailure = failure;
            // Keep a rejected lifecycle promise, not just an unavailable UI snapshot.
            throw error;
          }
          return failure;
        })
        .then((result) => {
          if (generation === startedGeneration) admission.set(derived.fingerprint, result);
          return result;
        })
        .finally(() => {
          operation.settled = true;
          for (const [caller, listener] of operation.callerListeners) {
            caller.removeEventListener("abort", listener);
          }
          operation.callerListeners.clear();
          if (!operation.retainedFailure) operations.delete(key);
        });
      operation = { controller, promise, callerListeners: new Map(), settled: false };
      operations.set(key, operation);
      join(operation, signal);
      // Fire-and-forget status callers do not hide lifecycle failure or trigger
      // unhandled rejection; drain() still observes the original rejected promise.
      void promise.catch((error: unknown) => {
        console.error("[Toolchains] Local probe cleanup failed:", localProbeFailureSnapshot(error).diagnostic);
      });
      return promise;
    },
    cancel,
    async drain(): Promise<void> {
      closing = true;
      cancel();
      const results = await Promise.allSettled([...operations.values()].map((operation) => operation.promise));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Local compatibility probe cleanup is unconfirmed");
      }
    },
  };
}

export const localProbeRegistry = createLocalProbeRegistry();
