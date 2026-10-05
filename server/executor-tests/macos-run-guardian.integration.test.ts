import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExecutorHealth,
  ExecutorRequest,
  ExecutorResponse,
  ExecutorRunResult,
  ExecutorRunSpec,
} from "../executor/protocol.js";

// Shared only by the paired lifecycle fault gate; retain the same identity and
// conservative cleanup checks for both suites.
export {
  withGateRuntime, startLongRun, cancelRun, waitForTrace, requireIdentity,
  assertKernelIdentity, assertExactGuardianCommand, assertGroupEmpty,
  assertGroupContains, assertNoRunProfileArtifacts, waitForGenerationExclusive,
  generationExclusiveAvailable, waitForProcessGone, gateId, sanitizedExecutorEnvironment,
  traceEvents, readTraceEvents, restartGateHarness,
};
export type { GateRuntime, InteractiveFaultPause, GateFaultEnvironment };

/*
 * Destructive Apple-Silicon fault gate.
 *
 * This file deliberately does not infer a sandbox PID/PGID from the executor's
 * direct children. The per-run guardian changes that ancestry, and PPID polling
 * also races reparenting. Source code under test must publish the trusted JSONL
 * trace contract below when both of these variables are present:
 *
 *   JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1
 *   JUDGEDESK_RUN_GUARDIAN_EVENT_LOG=/absolute/private/path
 *
 * The trace lives outside the sandbox workspace, is created mode 0600 by this
 * harness, and must never be passed to the untrusted launch environment.
 *
 * Required schema:
 * {
 *   "schema": "JUDGEDESK_RUN_GUARDIAN_FAULT_GATE/2",
 *   "phase": <stable protocol milestone; not a temporal sequence>,
 *   "event": "fault_gate_ready" | "guardian_ready" |
 *            "supervisor_registered" | "supervisor_ready" |
 *            "guardian_started" | "executor_active_committed" |
 *            "guardian_go" | "target_started" | "cleanup_requested" |
 *            "executor_fallback_drain_started" | "group_drained" |
 *            "supervisor_prepared" | "guardian_cleaned" |
 *            "interactive_spool_created" |
 *            "interactive_second_configure_paused" |
 *            "interactive_participant_enrolled" |
 *            "interactive_pair_enrolled",
 *   "runId": <run ID, or "executor" for fault_gate_ready>,
 *   "generation": <64 lowercase hex>,
 *   "guardian"?: { "pid": n, "pgid": n, "startAbstime": "n" },
 *   "anchor"?: { "pid": n, "pgid": n, "startAbstime": "n" },
 *   "target"?: { "pid": n, "pgid": n, "startAbstime": "n" }
 * }
 *
 * The executor must write fault_gate_ready before this test launches any
 * untrusted fixture. Therefore opting into the gate against a build which does
 * not implement the trace contract fails clearly without creating an orphan.
 * Trace events are test observability only; production containment must not
 * depend on this file.
 */

const GATE_REQUESTED =
  process.env.JUDGEDESK_RUN_GUARDIAN_FAULT_GATE === "1";
const SUPPORTED_GATE_HOST =
  process.platform === "darwin" && process.arch === "arm64";
const GATE_ENABLED = GATE_REQUESTED && SUPPORTED_GATE_HOST;
// An explicit opt-in on the wrong host is a configuration error, not a skip.
// With no opt-in, every host (including Windows CI) keeps the test discoverable
// without attempting a destructive macOS gate.
const SKIP_REASON = GATE_REQUESTED
  ? false
  : SUPPORTED_GATE_HOST
    ? "set JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1 to run destructive guardian faults"
    : "Apple-Silicon-only destructive run-guardian gate";
const TRACE_SCHEMA = "JUDGEDESK_RUN_GUARDIAN_FAULT_GATE/2";
const GUARDIAN_ARGUMENT = "--judgedesk-macos-run-guardian";
const SUPERVISOR_ARGUMENT = "--judgedesk-macos-run-supervisor";
const MAX_EXECUTOR_FRAME_BYTES = 1024 * 1024;
const MiB = 1024 * 1024;
const helperBinary = path.join(
  process.cwd(),
  "src-tauri",
  "binaries",
  `judgedesk-executor-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
);

interface ObservedProcessIdentity {
  pid: number;
  pgid: number;
  startAbstime: string;
}

type TraceEventName =
  | "fault_gate_ready"
  | "interactive_spool_created"
  | "interactive_second_configure_paused"
  | "interactive_participant_enrolled"
  | "interactive_pair_enrolled"
  | "guardian_ready"
  | "supervisor_registered"
  | "supervisor_ready"
  | "guardian_started"
  | "executor_active_committed"
  | "guardian_go"
  | "target_started"
  | "cleanup_requested"
  | "executor_fallback_drain_started"
  | "supervisor_prepared"
  | "group_drained"
  | "guardian_cleaned";

const TRACE_PHASE_BY_EVENT: Record<TraceEventName, number> = {
  fault_gate_ready: 1,
  interactive_spool_created: 5,
  interactive_second_configure_paused: 23,
  interactive_participant_enrolled: 34,
  interactive_pair_enrolled: 35,
  guardian_ready: 10,
  supervisor_registered: 20,
  supervisor_ready: 25,
  guardian_started: 30,
  executor_active_committed: 40,
  guardian_go: 50,
  target_started: 60,
  cleanup_requested: 70,
  executor_fallback_drain_started: 75,
  supervisor_prepared: 80,
  group_drained: 90,
  guardian_cleaned: 100,
};

interface GuardianTraceEvent {
  schema: typeof TRACE_SCHEMA;
  phase: number;
  event: TraceEventName;
  runId: string;
  generation: string;
  guardian?: ObservedProcessIdentity;
  anchor?: ObservedProcessIdentity;
  target?: ObservedProcessIdentity;
}

interface ObservedGuardianTraceEvent extends GuardianTraceEvent {
  // Harness metadata only; this field is not part of the on-disk trace schema.
  lineIndex: number;
}

interface PendingResponse {
  resolve(response: ExecutorResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ProcessRow {
  pid: number;
  pgid: number;
  command: string;
}

class NativeExecutorHarness {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingResponse>();
  private receiveBuffer = Buffer.alloc(0);
  private stderrPreview = "";
  private closedError: Error | null = null;
  private readonly exited: Promise<void>;

  constructor(environment: NodeJS.ProcessEnv) {
    this.child = spawn(helperBinary, [], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        const error = new Error(
          `Native executor exited (code=${code}, signal=${signal}). ${this.stderrPreview}`,
        );
        this.closedError = error;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        resolve();
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 16 * 1024 - Buffer.byteLength(this.stderrPreview);
      if (remaining > 0) {
        this.stderrPreview += chunk.subarray(0, remaining).toString("utf8");
      }
    });
    this.child.once("error", (error) => {
      this.closedError = error;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  get pid(): number {
    assert.ok(this.child.pid, "native executor PID is unavailable");
    return this.child.pid;
  }

  get hasExited(): boolean {
    return (
      this.closedError !== null ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }

  get stderrDiagnostic(): string {
    return this.stderrPreview;
  }

  async health(): Promise<ExecutorHealth> {
    const response = await this.request(
      { type: "health", id: crypto.randomUUID() },
      30_000,
    );
    assert.equal(response.type, "health", `expected health, received ${response.type}`);
    return response.health;
  }

  request(request: ExecutorRequest, timeoutMs = 90_000): Promise<ExecutorResponse> {
    if (this.closedError || !this.child.stdin.writable) {
      return Promise.reject(
        this.closedError ?? new Error("Native executor control pipe is unavailable."),
      );
    }
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    assert.ok(
      payload.length > 0 && payload.length <= MAX_EXECUTOR_FRAME_BYTES,
      "executor request exceeds framed-protocol bounds",
    );
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length);
    return new Promise<ExecutorResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const stderr = this.stderrPreview.trim();
        reject(
          new Error(
            `Native executor request ${request.id} timed out.` +
              (stderr ? ` Executor stderr: ${stderr}` : ""),
          ),
        );
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.child.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return;
        const pending = this.pending.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.id);
        pending.reject(error);
      });
    }).then((response) => {
      if (response.type === "error") {
        throw new Error(`${response.code}: ${response.message}`);
      }
      return response;
    });
  }

  signal(signal: NodeJS.Signals): void {
    assert.equal(this.hasExited, false, "native executor already exited");
    process.kill(this.pid, signal);
  }

  async waitForExit(timeoutMs = 10_000): Promise<void> {
    await withTimeout(this.exited, timeoutMs, "native executor did not exit");
  }

  async shutdown(): Promise<void> {
    if (this.hasExited) {
      await this.waitForExit();
      return;
    }
    const response = await this.request(
      { type: "shutdown", id: crypto.randomUUID() },
      30_000,
    );
    assert.equal(response.type, "shutdown_result");
    await this.waitForExit();
  }

  async forceStop(): Promise<void> {
    if (!this.hasExited) {
      try {
        process.kill(this.pid, "SIGKILL");
      } catch {
        // A concurrent close is equivalent to the desired cleanup.
      }
    }
    await this.waitForExit(5_000).catch(() => undefined);
  }

  private receive(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length === 0 || length > MAX_EXECUTOR_FRAME_BYTES) {
        const error = new Error(`Native executor emitted invalid frame length ${length}.`);
        this.closedError = error;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        return;
      }
      if (this.receiveBuffer.length < length + 4) return;
      const payload = this.receiveBuffer.subarray(4, length + 4);
      this.receiveBuffer = this.receiveBuffer.subarray(length + 4);
      const response = JSON.parse(payload.toString("utf8")) as ExecutorResponse;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }
}

interface GateCleanupContext {
  directory: string;
  eventLog: string;
  generation: string;
  executorRoot: string;
  executorPid?: number;
  // Paired reproductions cannot recover via numeric group signals until the
  // executor proves ownership with a retained pin. Preserve evidence instead.
  signalRecordedGroups?: boolean;
}

interface GateRuntime extends GateCleanupContext {
  temporaryDirectory: string;
  generationPath: string;
  harness: NativeExecutorHarness;
  health: ExecutorHealth;
  workspaceId: string;
  workspacePath: string;
  artifactPath: string;
  executableId: string;
  faultEnvironment: GateFaultEnvironment;
}

type InteractiveFaultPause = "second-configure" | "pair-commit" | "first-spool";

interface GateFaultEnvironment {
  JUDGEDESK_INTERACTIVE_FAULT_PAUSE?: InteractiveFaultPause;
}

interface CleanupReport {
  inventoryVerified: boolean;
  residual: ProcessRow[];
  diagnostics: string[];
}

function sanitizedExecutorEnvironment(
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    const loaderControl =
      normalized.startsWith("DYLD_") ||
      normalized.startsWith("__XPC_DYLD_") ||
      normalized.startsWith("LD_") ||
      ["LIBGMALLOC", "_RLD_ROOT", "LIBPATH", "SHLIB_PATH"].includes(normalized);
    const judgeDeskInternal = normalized.startsWith("JUDGEDESK_");
    if (!loaderControl && !judgeDeskInternal) {
      environment[key] = value;
    }
  }
  return { ...environment, ...overrides };
}

test(
  "macOS per-run guardian enforces destructive single-fault boundaries",
  { skip: SKIP_REASON, timeout: 240_000 },
  async (t) => {
    assert.equal(
      process.platform,
      "darwin",
      "JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1 is only valid on macOS",
    );
    assert.equal(
      process.arch,
      "arm64",
      "JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1 is only valid on Apple Silicon",
    );
    assert.equal(GATE_ENABLED, true);

    await t.test("registration is committed before GO", async () => {
      await withGateRuntime(async (runtime) => {
        const runId = gateId("ordering");
        const pending = startLongRun(runtime, runId);
        const registered = await waitForTrace(runtime, runId, "supervisor_registered");
        const ready = await waitForTrace(runtime, runId, "supervisor_ready");
        const started = await waitForTrace(runtime, runId, "guardian_started");
        const committed = await waitForTrace(
          runtime,
          runId,
          "executor_active_committed",
        );
        const go = await waitForTrace(runtime, runId, "guardian_go");
        const targetStarted = await waitForTrace(runtime, runId, "target_started");

        assert.ok(
          registered.lineIndex < ready.lineIndex &&
            ready.lineIndex < started.lineIndex &&
            started.lineIndex < committed.lineIndex &&
            committed.lineIndex < go.lineIndex &&
            go.lineIndex < targetStarted.lineIndex,
          `unsafe launch ordering: ${JSON.stringify([
            registered,
            ready,
            started,
            committed,
            go,
            targetStarted,
          ])}`,
        );
        const registeredAnchor = requireIdentity(registered, "anchor");
        assert.deepEqual(requireIdentity(ready, "anchor"), registeredAnchor);
        assert.deepEqual(requireIdentity(started, "anchor"), registeredAnchor);
        assert.deepEqual(requireIdentity(committed, "anchor"), registeredAnchor);
        assert.deepEqual(requireIdentity(go, "anchor"), registeredAnchor);
        assert.equal(registeredAnchor.pid, registeredAnchor.pgid);
        const guardian = requireIdentity(started, "guardian");
        const target = requireIdentity(targetStarted, "target");
        assert.deepEqual(requireIdentity(targetStarted, "anchor"), registeredAnchor);
        assert.equal(target.pgid, registeredAnchor.pgid);
        assert.notEqual(target.pid, registeredAnchor.pid);
        assertExactGuardianCommand(guardian.pid);
        assertExactSupervisorCommand(registeredAnchor.pid);
        assertKernelIdentity(guardian);
        assertKernelIdentity(registeredAnchor);
        assertKernelIdentity(target);
        assert.equal(await generationExclusiveAvailable(runtime.generationPath), false);

        assert.equal(await cancelRun(runtime, runId), true);
        const result = await pending;
        assert.equal(result.reason, "cancelled", JSON.stringify(result));
        await waitForTrace(runtime, runId, "group_drained");
        await assertGroupEmpty(registeredAnchor.pgid);
        assertNoRunProfileArtifacts(runtime, runId);
      });
    });

    await t.test("executor SIGKILL leaves guardian holding the generation until drain", async () => {
      await withGateRuntime(async (runtime) => {
        const runId = gateId("executor_kill");
        const pending = startLongRun(runtime, runId);
        const go = await waitForTrace(runtime, runId, "guardian_go");
        const guardian = requireIdentity(go, "guardian");
        const anchor = requireIdentity(go, "anchor");
        assertExactGuardianCommand(guardian.pid);
        assert.equal(await generationExclusiveAvailable(runtime.generationPath), false);

        runtime.harness.signal("SIGKILL");
        await assert.rejects(pending, /Native executor exited|control pipe/i);
        await runtime.harness.waitForExit();

        await waitForTrace(runtime, runId, "group_drained", 15_000);
        await waitForTrace(runtime, runId, "guardian_cleaned", 15_000);
        await assertGroupEmpty(anchor.pgid);
        await waitForProcessGone(guardian.pid, 10_000);
        await waitForGenerationExclusive(runtime.generationPath, 10_000);
        assertNoRunProfileArtifacts(runtime, runId);
      });
    });

    await t.test("guardian SIGKILL fails closed without numeric PID or PGID fallback", async () => {
      await withGateRuntime(async (runtime) => {
        const runId = gateId("guardian_kill");
        const pending = startLongRun(runtime, runId);
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const go = await waitForTrace(runtime, runId, "guardian_go");
        const targetStarted = await waitForTrace(runtime, runId, "target_started");
        const guardian = requireIdentity(go, "guardian");
        const anchor = requireIdentity(go, "anchor");
        assert.deepEqual(requireIdentity(targetStarted, "anchor"), anchor);
        const target = requireIdentity(targetStarted, "target");
        assertExactGuardianCommand(guardian.pid);

        process.kill(guardian.pid, "SIGKILL");
        await waitForProcessGone(guardian.pid, 10_000);
        await delay(500);

        assert.equal(settled, false, "guardian loss returned an unproven run result");
        assertKernelIdentity(anchor);
        assertKernelIdentity(target);
        const events = traceEvents(runtime.eventLog, runId);
        assert.equal(
          events.some((event) =>
            event.event === "executor_fallback_drain_started" ||
            event.event === "group_drained"
          ),
          false,
          "executor claimed a numeric fallback drain without an owned reap pin",
        );
        assert.equal(await generationExclusiveAvailable(runtime.generationPath), false);
      });
    });

    await t.test("two concurrent runs cancel independently", async () => {
      await withGateRuntime(async (runtime) => {
        const firstRun = gateId("concurrent_a");
        const secondRun = gateId("concurrent_b");
        const firstPending = startLongRun(runtime, firstRun);
        const secondPending = startLongRun(runtime, secondRun);
        const [firstGo, secondGo] = await Promise.all([
          waitForTrace(runtime, firstRun, "guardian_go"),
          waitForTrace(runtime, secondRun, "guardian_go"),
        ]);
        const firstGuardian = requireIdentity(firstGo, "guardian");
        const secondGuardian = requireIdentity(secondGo, "guardian");
        const firstAnchor = requireIdentity(firstGo, "anchor");
        const secondAnchor = requireIdentity(secondGo, "anchor");
        assert.notEqual(firstGuardian.pid, secondGuardian.pid);
        assert.notEqual(firstAnchor.pgid, secondAnchor.pgid);
        assertExactGuardianCommand(firstGuardian.pid);
        assertExactGuardianCommand(secondGuardian.pid);

        const exactGuardians = exactGuardianPids();
        assert.deepEqual(
          exactGuardians.sort((left, right) => left - right),
          [firstGuardian.pid, secondGuardian.pid].sort((left, right) => left - right),
          "unexpected guardian process inventory during two-run gate",
        );

        assert.equal(await cancelRun(runtime, firstRun), true);
        const firstResult = await firstPending;
        assert.equal(firstResult.reason, "cancelled", JSON.stringify(firstResult));
        await waitForTrace(runtime, firstRun, "group_drained");
        await assertGroupEmpty(firstAnchor.pgid);
        assertNoRunProfileArtifacts(runtime, firstRun);
        assertGroupContains(secondAnchor);
        assert.equal(
          traceEvents(runtime.eventLog, secondRun).some(
            (event) => event.event === "group_drained",
          ),
          false,
          "cancelling the first run drained the second run",
        );

        assert.equal(await cancelRun(runtime, secondRun), true);
        const secondResult = await secondPending;
        assert.equal(secondResult.reason, "cancelled", JSON.stringify(secondResult));
        await waitForTrace(runtime, secondRun, "group_drained");
        await assertGroupEmpty(secondAnchor.pgid);
        assertNoRunProfileArtifacts(runtime, secondRun);
        assert.equal(await generationExclusiveAvailable(runtime.generationPath), false);

        await runtime.harness.shutdown();
        await waitForGenerationExclusive(runtime.generationPath, 10_000);
      });
    });
  },
);

async function createGateRuntime(
  signalRecordedGroups = true,
  faultEnvironment: GateFaultEnvironment = {},
): Promise<GateRuntime> {
  validateGateFaultEnvironment(faultEnvironment);
  assert.ok(
    fs.existsSync(helperBinary),
    `Build the native executor before the fault gate: ${helperBinary}`,
  );
  assert.ok(
    fs.existsSync("/usr/bin/python3"),
    "The fault gate requires /usr/bin/python3 for nonblocking flock probes.",
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-run-guardian-gate-"),
  );
  fs.chmodSync(directory, 0o700);
  const temporaryDirectory = path.join(directory, "tmp");
  fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
  const expectedExecutorRoot = path.join(temporaryDirectory, "JudgeDeskExecutor");
  const eventLog = path.join(directory, "guardian-events.jsonl");
  fs.writeFileSync(eventLog, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  const generation = crypto.randomBytes(32).toString("hex");
  const generationPath = path.join(directory, "process-tree.generation");
  fs.writeFileSync(
    generationPath,
    `JUDGEDESK_PROCESS_TREE/1\ngeneration=${generation}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  const harness = new NativeExecutorHarness(sanitizedExecutorEnvironment({
    TMPDIR: temporaryDirectory,
    JUDGEDESK_TREE_GUARD_REQUIRED: "1",
    JUDGEDESK_TREE_GUARD_PATH: generationPath,
    JUDGEDESK_TREE_GUARD_GENERATION: generation,
    JUDGEDESK_PARENT_PID: String(process.pid),
    JUDGEDESK_RUN_GUARDIAN_FAULT_GATE: "1",
    JUDGEDESK_RUN_GUARDIAN_EVENT_LOG: eventLog,
    JUDGEDESK_INTERACTIVE_FAULT_PAUSE: faultEnvironment.JUDGEDESK_INTERACTIVE_FAULT_PAUSE,
  }));

  try {
    const health = await harness.health();
    assert.equal(health.ready, true, health.diagnostics.join("; "));
    assert.equal(
      fs.existsSync(expectedExecutorRoot),
      true,
      "native executor did not initialize its root inside the isolated TMPDIR",
    );
    const resolvedExecutorRoot = fs.realpathSync(expectedExecutorRoot);
    assert.equal(
      fs.realpathSync(health.executorRoot),
      resolvedExecutorRoot,
      "native executor root escaped the gate's isolated TMPDIR",
    );

    // Capability handshake: fail before launching a hostile/long-lived fixture
    // when source code has not implemented the trusted event-log contract.
    await waitForTracePath(
      eventLog,
      generation,
      "executor",
      "fault_gate_ready",
      3_000,
      "Native executor did not advertise the guardian fault-gate trace contract. " +
        "Implement JUDGEDESK_RUN_GUARDIAN_EVENT_LOG before enabling this gate.",
    );

    const workspaceId = gateId("workspace");
    const workspacePath = path.join(health.executorRoot, "workspaces", workspaceId);
    fs.mkdirSync(workspacePath, { recursive: false });
    const artifactName = `guardian-gate-${crypto.randomUUID()}`;
    const artifactPath = path.join(health.executorRoot, "artifacts", artifactName);
    fs.copyFileSync(helperBinary, artifactPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(artifactPath, 0o500);

    return {
      directory,
      temporaryDirectory,
      eventLog,
      generation,
      executorRoot: resolvedExecutorRoot,
      executorPid: harness.pid,
      generationPath,
      harness,
      health,
      workspaceId,
      workspacePath,
      artifactPath,
      executableId: `artifacts/${artifactName}`,
      signalRecordedGroups,
      faultEnvironment: { ...faultEnvironment },
    };
  } catch (error) {
    const beforeCleanup = captureGateTrace(eventLog);
    await harness.forceStop();
    const cleanup = await cleanupObservedProcesses({
      directory,
      eventLog,
      generation,
      executorRoot: expectedExecutorRoot,
      executorPid: harness.child.pid,
      signalRecordedGroups,
    });
    const cleanupError = cleanupReportError(
      {
        directory,
        eventLog,
        generation,
        executorRoot: expectedExecutorRoot,
        executorPid: harness.child.pid,
        signalRecordedGroups,
      },
      cleanup,
    );
    const evidenceError = persistGateEvidence({ directory, eventLog, generation,
      executorRoot: expectedExecutorRoot, executorPid: harness.child.pid },
      cleanup, harness.stderrDiagnostic, beforeCleanup);
    if (!cleanupError && !evidenceError) {
      removeGateDirectory(directory);
    } else {
      throw new AggregateError(
        [error, cleanupError, evidenceError].filter((failure) => failure !== undefined),
        `gate initialization, cleanup or evidence preservation failed; preserved ${directory}`,
      );
    }
    throw error;
  }
}

async function withGateRuntime(
  operation: (runtime: GateRuntime) => Promise<void>,
  signalRecordedGroups = true,
  faultEnvironment: GateFaultEnvironment = {},
): Promise<void> {
  const runtime = await createGateRuntime(signalRecordedGroups, faultEnvironment);
  let operationError: unknown;
  try {
    await operation(runtime);
  } catch (error) {
    operationError = error;
  }

  const beforeCleanup = captureGateTrace(runtime.eventLog);
  await runtime.harness.forceStop();
  const cleanup = await cleanupObservedProcesses(runtime);
  const cleanupError = cleanupReportError(runtime, cleanup);
  const evidenceError = persistGateEvidence(runtime, cleanup, runtime.harness.stderrDiagnostic, beforeCleanup);
  if (!cleanupError && !evidenceError) {
    removeGateDirectory(runtime.directory);
  }

  if (evidenceError) {
    throw new AggregateError([operationError, cleanupError, evidenceError].filter((failure) => failure !== undefined),
      `gate evidence preservation failed after cleanup; preserved ${runtime.directory}`);
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `gate operation failed and cleanup was incomplete; preserved ${runtime.directory}`,
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

function captureGateTrace(eventLog: string): Buffer | Error | undefined {
  if (process.env.JUDGEDESK_RUN_GUARDIAN_EVIDENCE_DIRECTORY === undefined) return undefined;
  try {
    return fs.readFileSync(eventLog);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function persistGateEvidence(runtime: GateCleanupContext, cleanup: CleanupReport,
  stderr: string, beforeCleanup: Buffer | Error | undefined): Error | undefined {
  const supplied = process.env.JUDGEDESK_RUN_GUARDIAN_EVIDENCE_DIRECTORY;
  if (supplied === undefined) return undefined;
  try {
    if (beforeCleanup instanceof Error) throw beforeCleanup;
    assert.ok(beforeCleanup, "missing pre-cleanup evidence snapshot");
    assert.ok(path.isAbsolute(supplied), "evidence directory must be absolute");
    const destination = path.resolve(supplied);
    assert.equal(fs.realpathSync(destination), destination, "evidence directory must be canonical without links");
    const directoryStat = fs.lstatSync(destination);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
    const markerPath = path.join(destination, ".judgedesk-run-guardian-evidence-owner");
    const markerStat = fs.lstatSync(markerPath);
    assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink(), "evidence owner marker must be a regular file");
    assert.equal(fs.readFileSync(markerPath, "utf8"), "JUDGEDESK_RUN_GUARDIAN_EVIDENCE/1\n");
    assert.match(runtime.generation, /^[0-9a-f]{64}$/);
    const prefix = path.join(destination, runtime.generation);
    const binaryPath = fs.realpathSync(helperBinary);
    const binaryStat = fs.statSync(binaryPath);
    const binarySha256 = crypto.createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex");
    const options = { flag: "wx", mode: 0o600 };
    fs.writeFileSync(`${prefix}.jsonl`, fs.readFileSync(runtime.eventLog), options);
    fs.writeFileSync(`${prefix}.stderr.log`, stderr, options);
    fs.writeFileSync(`${prefix}.json`, JSON.stringify({
      schema: "JUDGEDESK_RUN_GUARDIAN_EVIDENCE/1", generation: runtime.generation,
      runtimeDirectory: runtime.directory, executorRoot: runtime.executorRoot, executorPid: runtime.executorPid,
      beforeCleanupTrace: beforeCleanup.toString("utf8"), cleanup,
      binary: { path: binaryPath, sha256: binarySha256, bytes: binaryStat.size, dev: binaryStat.dev, ino: binaryStat.ino },
    }, null, 2) + "\n", options);
    const restartArchive = `${runtime.eventLog}.before-restart`;
    if (fs.existsSync(restartArchive)) {
      assert.ok(fs.lstatSync(restartArchive).isFile() && !fs.lstatSync(restartArchive).isSymbolicLink());
      fs.writeFileSync(`${prefix}.before-restart.jsonl`, fs.readFileSync(restartArchive), options);
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function validateGateFaultEnvironment(environment: GateFaultEnvironment): void {
  assert.ok(Object.keys(environment).every((key) => key === "JUDGEDESK_INTERACTIVE_FAULT_PAUSE"),
    "fault gate environment cannot override the controlled runtime, generation, or trace root");
  const pause = environment.JUDGEDESK_INTERACTIVE_FAULT_PAUSE;
  assert.ok(pause === undefined || ["second-configure", "pair-commit", "first-spool"].includes(pause),
    "invalid interactive fault pause enum");
}

async function restartGateHarness(runtime: GateRuntime): Promise<void> {
  validateGateFaultEnvironment(runtime.faultEnvironment);
  assert.equal(runtime.faultEnvironment.JUDGEDESK_INTERACTIVE_FAULT_PAUSE, "first-spool",
    "controlled restart is restricted to the otherwise-idle first-spool reproduction");
  assert.equal(runtime.harness.hasExited, true, "cannot restart beside a live executor");
  await runtime.harness.waitForExit();
  const events = readTraceEvents(runtime.eventLog)
    .filter((event) => event.generation === runtime.generation);
  const groups = new Set(events.flatMap((event) => event.anchor ? [event.anchor.pgid] : []));
  for (const pgid of groups) await assertGroupEmpty(pgid);
  await waitForGenerationExclusive(runtime.generationPath, 5_000);
  assert.equal(fs.realpathSync(runtime.executorRoot),
    fs.realpathSync(path.join(runtime.temporaryDirectory, "JudgeDeskExecutor")));

  // Preserve the original authenticated evidence and give the restarted executor
  // its own log: fault_gate_ready is unique within each parsed trace stream.
  const archivedTrace = `${runtime.eventLog}.before-restart`;
  assert.equal(fs.existsSync(archivedTrace), false, "gate runtime supports one controlled restart");
  fs.renameSync(runtime.eventLog, archivedTrace);
  fs.writeFileSync(runtime.eventLog, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  runtime.harness = new NativeExecutorHarness(sanitizedExecutorEnvironment({
    TMPDIR: runtime.temporaryDirectory,
    JUDGEDESK_TREE_GUARD_REQUIRED: "1",
    JUDGEDESK_TREE_GUARD_PATH: runtime.generationPath,
    JUDGEDESK_TREE_GUARD_GENERATION: runtime.generation,
    JUDGEDESK_PARENT_PID: String(process.pid),
    JUDGEDESK_RUN_GUARDIAN_FAULT_GATE: "1",
    JUDGEDESK_RUN_GUARDIAN_EVENT_LOG: runtime.eventLog,
    JUDGEDESK_INTERACTIVE_FAULT_PAUSE: runtime.faultEnvironment.JUDGEDESK_INTERACTIVE_FAULT_PAUSE,
  }));
  runtime.executorPid = runtime.harness.pid;
  const health = await runtime.harness.health();
  assert.equal(health.ready, true, health.diagnostics.join("; "));
  assert.equal(fs.realpathSync(health.executorRoot), fs.realpathSync(runtime.executorRoot),
    "restart escaped the controlled executor root");
  runtime.health = health;
  await waitForTrace(runtime, "executor", "fault_gate_ready", 3_000);
}

function startLongRun(
  runtime: GateRuntime,
  runId: string,
): Promise<ExecutorRunResult> {
  const spec: ExecutorRunSpec = {
    runId,
    role: "security-probe",
    workspaceId: runtime.workspaceId,
    executableId: runtime.executableId,
    args: ["--test-sleep-ms", "30000"],
    stdoutFile: `${runId}.stdout`,
    stderrFile: `${runId}.stderr`,
    environment: {},
    limits: {
      wallTimeMs: 60_000,
      memoryBytes: 128 * MiB,
      processCount: 1,
      threadCount: 64,
      outputBytes: MiB,
      totalWriteBytes: 4 * MiB,
      openFiles: 64,
      createdFiles: 16,
    },
  };
  return runtime.harness
    .request({ type: "run", id: crypto.randomUUID(), spec }, 90_000)
    .then((response) => {
      assert.equal(response.type, "run_result", `expected run_result, got ${response.type}`);
      assert.equal(response.result.runId, runId, "run_result returned the wrong runId");
      return response.result;
    });
}

async function cancelRun(runtime: GateRuntime, runId: string): Promise<boolean> {
  const response = await runtime.harness.request(
    { type: "cancel", id: crypto.randomUUID(), runId },
    15_000,
  );
  assert.equal(response.type, "cancel_result", `expected cancel_result, got ${response.type}`);
  assert.equal(response.runId, runId);
  return response.cancelled;
}

async function waitForTrace(
  runtime: GateRuntime,
  runId: string,
  event: TraceEventName,
  timeoutMs = 10_000,
): Promise<ObservedGuardianTraceEvent> {
  return waitForTracePath(
    runtime.eventLog,
    runtime.generation,
    runId,
    event,
    timeoutMs,
    `Timed out waiting for trusted guardian trace ${event} for ${runId}.`,
  );
}

async function waitForTracePath(
  eventLog: string,
  generation: string,
  runId: string,
  event: TraceEventName,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<ObservedGuardianTraceEvent> {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = traceEvents(eventLog, runId).find(
      (candidate) =>
        candidate.event === event && candidate.generation === generation,
    );
    if (found) return found;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(timeoutMessage);
}

function traceEvents(
  eventLog: string,
  runId: string,
): ObservedGuardianTraceEvent[] {
  return readTraceEvents(eventLog).filter((event) => event.runId === runId);
}

function readTraceEvents(eventLog: string): ObservedGuardianTraceEvent[] {
  const contents = fs.readFileSync(eventLog, "utf8");
  const complete = contents.endsWith("\n")
    ? contents
    : contents.slice(0, contents.lastIndexOf("\n") + 1);
  if (!complete) return [];
  const events = complete
    .split("\n")
    .map((line, index) => ({ line, lineIndex: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineIndex }) => ({
      ...parseTraceEvent(line, lineIndex),
      lineIndex,
    }));

  const uniqueEvents = new Set<string>();
  for (const event of events) {
    const runKey = `${event.generation}\u0000${event.runId}`;
    const eventKey = `${runKey}\u0000${event.event}`;
    assert.equal(
      uniqueEvents.has(eventKey),
      false,
      `duplicate trace event ${event.event} for ${event.runId} at line ${event.lineIndex}`,
    );
    uniqueEvents.add(eventKey);
  }
  return events;
}

function parseTraceEvent(line: string, lineNumber: number): GuardianTraceEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Malformed guardian trace line ${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assertRecord(value, `guardian trace line ${lineNumber}`);
  assert.equal(value.schema, TRACE_SCHEMA, `trace schema at line ${lineNumber}`);
  assert.ok(
    typeof value.event === "string" &&
      Object.hasOwn(TRACE_PHASE_BY_EVENT, value.event),
    `invalid trace event at line ${lineNumber}`,
  );
  const event = value.event as TraceEventName;
  assert.equal(
    value.phase,
    TRACE_PHASE_BY_EVENT[event],
    `trace phase at line ${lineNumber}`,
  );
  assert.ok(
    typeof value.runId === "string",
    `trace runId at line ${lineNumber}`,
  );
  assert.match(value.runId, /^[A-Za-z0-9_-]{1,96}$/);
  assert.ok(
    typeof value.generation === "string",
    `trace generation at line ${lineNumber}`,
  );
  assert.match(value.generation, /^[0-9a-f]{64}$/);
  if (value.guardian !== undefined) parseIdentity(value.guardian, "guardian");
  if (value.anchor !== undefined) parseIdentity(value.anchor, "anchor");
  if (value.target !== undefined) parseIdentity(value.target, "target");
  return value as unknown as GuardianTraceEvent;
}

function requireIdentity(
  event: GuardianTraceEvent,
  field: "guardian" | "anchor" | "target",
): ObservedProcessIdentity {
  const identity = event[field];
  assert.ok(identity, `${event.event} did not include ${field} identity`);
  return parseIdentity(identity, field);
}

function parseIdentity(
  value: unknown,
  label: string,
): ObservedProcessIdentity {
  assertRecord(value, label);
  assert.ok(
    Number.isSafeInteger(value.pid) && Number(value.pid) > 1,
    `${label} PID is invalid`,
  );
  assert.ok(
    Number.isSafeInteger(value.pgid) && Number(value.pgid) > 1,
    `${label} PGID is invalid`,
  );
  assert.match(String(value.startAbstime), /^[1-9][0-9]*$/, `${label} start identity`);
  return {
    pid: Number(value.pid),
    pgid: Number(value.pgid),
    startAbstime: String(value.startAbstime),
  };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
}

function assertExactGuardianCommand(pid: number): void {
  const command = commandForPid(pid);
  const expected = guardianCommands();
  assert.ok(
    expected.includes(command),
    `PID ${pid} is not the exact test-owned guardian command; observed=${JSON.stringify(
      command,
    )}, expected one of ${JSON.stringify(expected)}`,
  );
}

function assertExactSupervisorCommand(pid: number): void {
  const command = commandForPid(pid);
  const expected = internalCommands(SUPERVISOR_ARGUMENT);
  assert.ok(
    expected.includes(command),
    `PID ${pid} is not the exact test-owned supervisor command; observed=${JSON.stringify(
      command,
    )}, expected one of ${JSON.stringify(expected)}`,
  );
}

function assertKernelIdentity(expected: ObservedProcessIdentity): void {
  const actual = kernelIdentityForPid(expected.pid);
  assert.ok(
    actual,
    `could not verify kernel identity ${JSON.stringify(expected)}`,
  );
  assert.deepEqual(actual, expected, `stale or replaced process identity for PID ${expected.pid}`);
}

function kernelIdentityForPid(pid: number): ObservedProcessIdentity | null {
  const result = spawnSync(
    helperBinary,
    ["--test-process-identity", String(pid)],
    {
      encoding: "utf8",
      env: sanitizedExecutorEnvironment({}),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  try {
    return parseIdentity(
      JSON.parse(result.stdout) as unknown,
      `kernel identity for PID ${pid}`,
    );
  } catch {
    return null;
  }
}

function sameProcessIdentity(
  left: ObservedProcessIdentity,
  right: ObservedProcessIdentity,
): boolean {
  return left.pid === right.pid &&
    left.pgid === right.pgid &&
    left.startAbstime === right.startAbstime;
}

function exactGuardianPids(): number[] {
  const expected = new Set(guardianCommands());
  return processRows()
    .filter((row) => expected.has(row.command))
    .map((row) => row.pid);
}

function guardianCommands(): string[] {
  return internalCommands(GUARDIAN_ARGUMENT);
}

function internalCommands(argument: string): string[] {
  const candidates = new Set([
    `${helperBinary} ${argument}`,
    `${fs.realpathSync(helperBinary)} ${argument}`,
  ]);
  return [...candidates];
}

function commandForPid(pid: number): string {
  const result = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `ps could not inspect PID ${pid}: ${result.stderr}`);
  return result.stdout.trim();
}

function processRows(): ProcessRow[] {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,pgid=,command="], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `ps inventory failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      command: match[3],
    }));
}

function assertGroupContains(identity: ObservedProcessIdentity): void {
  const members = processRows().filter((row) => row.pgid === identity.pgid);
  assert.ok(
    members.some((row) => row.pid === identity.pid),
    `anchor identity ${JSON.stringify(identity)} is no longer in its recorded group`,
  );
}

async function assertGroupEmpty(pgid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    const members = processRows().filter((row) => row.pgid === pgid);
    if (members.length === 0) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.deepEqual(
    processRows().filter((row) => row.pgid === pgid),
    [],
    `process group ${pgid} did not drain`,
  );
}

function assertNoRunProfileArtifacts(
  runtime: GateRuntime,
  runId: string,
): void {
  const profileDirectory = path.join(runtime.executorRoot, "profiles");
  const prefix = `${runId}-`;
  const residual = fs.readdirSync(profileDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sb"));
  assert.deepEqual(
    residual,
    [],
    `Seatbelt profiles remained after process-group proof for ${runId}`,
  );
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const row = processRows().find((candidate) => candidate.pid === pid);
    if (!row) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`PID ${pid} remained after its drain deadline.`);
}

async function generationExclusiveAvailable(generationPath: string): Promise<boolean> {
  const script = [
    "import errno, fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_RDWR)",
    "try:",
    "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except OSError as error:",
    "    os.close(fd)",
    "    sys.exit(75 if error.errno in (errno.EACCES, errno.EAGAIN) else 76)",
    "os.close(fd)",
    "sys.exit(0)",
  ].join("\n");
  const result = spawnSync("/usr/bin/python3", ["-c", script, generationPath], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 75) return false;
  throw new Error(
    `generation lock probe failed (status=${result.status}): ${result.stderr}`,
  );
}

async function waitForGenerationExclusive(
  generationPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await generationExclusiveAvailable(generationPath)) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error("generation exclusive lock remained blocked after tree drain");
}

async function cleanupObservedProcesses(
  runtime: GateCleanupContext,
): Promise<CleanupReport> {
  const parsed = bestEffortTraceEvents(runtime.eventLog, runtime.generation);
  const diagnostics = new Set(parsed.diagnostics);
  const events = parsed.events.filter(
    (event) => event.generation === runtime.generation,
  );
  const recordedGuardians = [
    ...events.flatMap((event) => event.guardian ? [event.guardian] : []),
    ...parsed.recoveredGuardians,
  ];
  const recordedGuardianPids = new Set(
    recordedGuardians.map((identity) => identity.pid),
  );
  const recordedAnchors = [
    ...events.flatMap((event) => event.anchor ? [event.anchor] : []),
    ...parsed.recoveredAnchors,
  ];
  const recordedAnchorPids = new Set(
    recordedAnchors.map((identity) => identity.pid),
  );
  const recordedGroups = new Set(
    recordedAnchors.map((identity) => identity.pgid),
  );
  const exactGuardianCommands = new Set(guardianCommands());
  const exactSupervisorCommands = new Set(
    internalCommands(SUPERVISOR_ARGUMENT),
  );
  const deadline = Date.now() + 5_000;
  let residual: ProcessRow[] = [];

  do {
    let rows: ProcessRow[];
    try {
      rows = processRows();
    } catch (error) {
      diagnostics.add(
        `process inventory failed during cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        inventoryVerified: false,
        residual,
        diagnostics: [...diagnostics],
      };
    }

    for (const row of rows) {
      if (runtime.signalRecordedGroups !== false && runtime.executorPid === row.pid) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch {
          // A concurrent exit is equivalent to the requested cleanup.
        }
      }
      if (
        recordedGuardianPids.has(row.pid) &&
        exactGuardianCommands.has(row.command)
      ) {
        const currentIdentity = kernelIdentityForPid(row.pid);
        const identityMatches = currentIdentity !== null &&
          recordedGuardians.some((identity) =>
            sameProcessIdentity(identity, currentIdentity)
          );
        if (identityMatches) {
          try {
            process.kill(row.pid, "SIGKILL");
          } catch {
            // A concurrent exit is equivalent to the requested cleanup.
          }
        } else {
          diagnostics.add(
            `refused stale or unverifiable guardian PID ${row.pid}`,
          );
        }
      }
      if (runtimeOwnsCommand(runtime, row.command) && row.pgid > 1) {
        recordedGroups.add(row.pgid);
      }
    }

    for (const pgid of recordedGroups) {
      if (runtime.signalRecordedGroups === false) {
        if (rows.some((row) => row.pgid === pgid)) {
          diagnostics.add(`preserved group ${pgid}: paired recovery refuses numeric group signals without an owned pin`);
        }
        continue;
      }
      safeKillRecordedGroup(
        runtime,
        pgid,
        rows,
        recordedAnchors,
        exactSupervisorCommands,
        diagnostics,
      );
    }

    residual = residualGateRows(
      runtime,
      rows,
      recordedGroups,
      recordedGuardianPids,
      recordedAnchorPids,
    );
    if (residual.length === 0) {
      // A second physical inventory prevents a just-exiting process from being
      // mistaken for a proven-empty cleanup.
      await delay(20);
      try {
        const confirmation = processRows();
        residual = residualGateRows(
          runtime,
          confirmation,
          recordedGroups,
          recordedGuardianPids,
          recordedAnchorPids,
        );
      } catch (error) {
        diagnostics.add(
          `cleanup confirmation inventory failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {
          inventoryVerified: false,
          residual,
          diagnostics: [...diagnostics],
        };
      }
      if (residual.length === 0) {
        return {
          inventoryVerified: true,
          residual: [],
          diagnostics: [...diagnostics],
        };
      }
    }
    await delay(20);
  } while (Date.now() < deadline);

  return {
    inventoryVerified: true,
    residual,
    diagnostics: [...diagnostics],
  };
}

function bestEffortTraceEvents(
  eventLog: string,
  expectedGeneration: string,
): {
  events: ObservedGuardianTraceEvent[];
  recoveredGuardians: ObservedProcessIdentity[];
  recoveredAnchors: ObservedProcessIdentity[];
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  let contents: string;
  try {
    contents = fs.readFileSync(eventLog, "utf8");
  } catch (error) {
    return {
      events: [],
      recoveredGuardians: [],
      recoveredAnchors: [],
      diagnostics: [
        `could not read cleanup trace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  const events: ObservedGuardianTraceEvent[] = [];
  const recoveredGuardians: ObservedProcessIdentity[] = [];
  const recoveredAnchors: ObservedProcessIdentity[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line) continue;
    const lineIndex = index + 1;
    try {
      events.push({ ...parseTraceEvent(line, lineIndex), lineIndex });
    } catch (error) {
      diagnostics.push(
        `ignored malformed cleanup trace line ${lineIndex}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        const value: unknown = JSON.parse(line);
        assertRecord(value, `cleanup trace line ${lineIndex}`);
        if (value.generation !== expectedGeneration) continue;
        for (const [field, destination] of [
          ["guardian", recoveredGuardians],
          ["anchor", recoveredAnchors],
        ] as const) {
          if (value[field] === undefined) continue;
          try {
            destination.push(
              parseIdentity(value[field], `recovered ${field} at line ${lineIndex}`),
            );
          } catch (identityError) {
            diagnostics.push(
              `could not recover ${field} identity at line ${lineIndex}: ${
                identityError instanceof Error
                  ? identityError.message
                  : String(identityError)
              }`,
            );
          }
        }
      } catch {
        // Invalid JSON has no trustworthy identity fields to recover.
      }
    }
  }
  return {
    events,
    recoveredGuardians,
    recoveredAnchors,
    diagnostics,
  };
}

function safeKillRecordedGroup(
  runtime: GateCleanupContext,
  pgid: number,
  rows: ProcessRow[],
  recordedAnchors: ObservedProcessIdentity[],
  exactSupervisorCommands: Set<string>,
  diagnostics: Set<string>,
): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    diagnostics.add(`refused invalid recorded PGID ${pgid}`);
    return;
  }
  const current = rows.find((row) => row.pid === process.pid);
  if (current?.pgid === pgid) {
    diagnostics.add(`refused to signal the test harness process group ${pgid}`);
    return;
  }
  const members = rows.filter((row) => row.pgid === pgid);
  if (members.length === 0) return;
  const membersOwned = members.every((member) => {
    if (runtimeOwnsCommand(runtime, member.command)) return true;
    if (!exactSupervisorCommands.has(member.command)) return false;
    const currentIdentity = kernelIdentityForPid(member.pid);
    return currentIdentity !== null &&
      recordedAnchors.some((identity) =>
        sameProcessIdentity(identity, currentIdentity)
      );
  });
  if (!membersOwned) {
    diagnostics.add(
      `refused group ${pgid} with an unverified command: ${JSON.stringify(members)}`,
    );
    return;
  }
  for (const signal of ["SIGSTOP", "SIGKILL"] as const) {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      diagnostics.add(
        `cleanup ${signal} for group ${pgid} raced or failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function residualGateRows(
  runtime: GateCleanupContext,
  rows: ProcessRow[],
  recordedGroups: Set<number>,
  recordedGuardianPids: Set<number>,
  recordedAnchorPids: Set<number>,
): ProcessRow[] {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) {
    if (
      runtime.executorPid === row.pid ||
      recordedGroups.has(row.pgid) ||
      recordedGuardianPids.has(row.pid) ||
      recordedAnchorPids.has(row.pid) ||
      runtimeOwnsCommand(runtime, row.command)
    ) {
      byPid.set(row.pid, row);
    }
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

function runtimeOwnsCommand(
  runtime: GateCleanupContext,
  command: string,
): boolean {
  const markers = new Set([
    path.resolve(runtime.executorRoot),
    path.resolve(runtime.directory),
  ]);
  for (const candidate of [...markers]) {
    try {
      if (fs.existsSync(candidate)) markers.add(fs.realpathSync(candidate));
    } catch {
      // The lexical marker is still useful after a concurrent path removal.
    }
  }
  return [...markers].some((marker) => command.includes(marker));
}

function cleanupReportError(
  runtime: GateCleanupContext,
  report: CleanupReport,
): Error | null {
  if (report.inventoryVerified && report.residual.length === 0) return null;
  return new Error(
    `run-guardian cleanup could not prove an empty process inventory; ` +
      `preserved ${runtime.directory}; inventoryVerified=${report.inventoryVerified}; ` +
      `residual=${JSON.stringify(report.residual)}; ` +
      `diagnostics=${JSON.stringify(report.diagnostics)}`,
  );
}

function removeGateDirectory(directory: string): void {
  const expectedPrefix = path.join(os.tmpdir(), "judgedesk-run-guardian-gate-");
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(expectedPrefix),
    `refusing to remove non-gate directory ${resolved}`,
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function gateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
