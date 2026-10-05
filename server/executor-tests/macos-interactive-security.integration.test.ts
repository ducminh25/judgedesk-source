import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import type { ExecutorLimits, ExecutorRunReason } from "../executor/protocol.js";
import {
  preparePair, startPair, provePairDrained, observed, bounded, logFailureEvidence,
} from "./macos-interactive-lifecycle.integration.test.js";
import {
  withGateRuntime, waitForTrace, waitForGenerationExclusive, sanitizedExecutorEnvironment,
  type GateRuntime,
} from "./macos-run-guardian.integration.test.js";

// This suite uses a separate explicit gate and a focused test-name pattern.
// Importing shared harnesses registers their gates but must not run those gates.
// No sandboxed fixture runs during the ordinary cross-platform server suite.
const MiB = 1024 * 1024;
const cases: readonly {
  name: string;
  fixture: boolean;
  args: readonly string[];
  limits: Partial<ExecutorLimits>;
  reason: ExecutorRunReason;
  receipt?: string;
}[] = [
  { name: "process quota", fixture: true, args: ["fork-hold"], limits: { processCount: 1 }, reason: "process_limit" },
  { name: "thread quota", fixture: false, args: ["thread-bomb", "16", "5000"], limits: { threadCount: 2 }, reason: "thread_limit" },
  { name: "kernel open-file quota", fixture: true, args: ["open-limit", "16"], limits: { openFiles: 16 }, reason: "exited", receipt: "open-files-clamped\n" },
  { name: "aggregate write quota", fixture: true, args: ["write-limit"], limits: { outputBytes: 4096, totalWriteBytes: 8192 }, reason: "write_limit" },
  { name: "created-file quota", fixture: true, args: ["write-limit"], limits: { createdFiles: 1 }, reason: "write_limit" },
  { name: "1.001 second wall deadline", fixture: false, args: ["sleep-ms", "5000"], limits: { wallTimeMs: 1001 }, reason: "wall_time_limit" },
  { name: "8 MiB memory floor accepts a small target", fixture: false, args: ["sleep-ms", "100"], limits: { memoryBytes: 8 * MiB }, reason: "exited" },
  { name: "8 MiB memory floor stops sustained excess", fixture: false, args: ["allocate-mib", "32", "5000"], limits: { memoryBytes: 8 * MiB }, reason: "memory_limit" },
  // This tests the actual 1024 MiB role limit with a live allocation below it.
  // It does not claim to test a 1025 MiB allocation or host memory exhaustion.
  { name: "1024 MiB memory boundary admits a bounded live allocation", fixture: false, args: ["allocate-mib", "16", "200"], limits: { memoryBytes: 1024 * MiB }, reason: "exited" },
];

test("macOS paired security and boundary gate configuration", { timeout: 300_000 }, async (t) => {
  if (process.env.JUDGEDESK_INTERACTIVE_SECURITY_GATE !== "1") {
    t.diagnostic("Paired security requires JUDGEDESK_INTERACTIVE_SECURITY_GATE=1 and the owned guardian gate on Apple Silicon.");
    return;
  }
  assert.equal(process.env.JUDGEDESK_RUN_GUARDIAN_FAULT_GATE, "1");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  for (const side of ["submission", "interactor"] as const) {
    await t.test(`${side} and its bounded descendant cannot reach network, external files, or escape their group`, async () => {
      await guarded(async (runtime) => {
        const pair = preparePair(runtime, "resources");
        const actor = pair[side];
        const peer = pair[side === "submission" ? "interactor" : "submission"];
        actor.executableId = compileContainment(runtime, actor.runId);
        // Checker policy requires exactly one process. Preserve that policy and
        // require the excess child's denial receipt before crediting its probes.
        actor.limits.processCount = side === "submission" ? 8 : 1;
        peer.args = ["sleep-ms", "5000"];
        const sentinel = path.join(runtime.directory, "external-canary.txt");
        const content = "paired-external-canary\n";
        fs.writeFileSync(sentinel, content, { flag: "wx", mode: 0o600 });
        const before = fs.lstatSync(sentinel);
        let accepted = 0;
        const listener = net.createServer((socket) => { ++accepted; socket.destroy(); });
        let port = 0;
        try {
          await listen(listener, 0);
          const address = listener.address();
          assert.ok(address && typeof address !== "string");
          port = address.port;
          actor.args = ["containment", sentinel, String(port), side === "submission" ? "exit" : "hold"];
          const pending = observed(startPair(runtime, pair));
          const enrolled = await registrations(runtime, pair);
          const outcome = await bounded(pending, 10_000, "containment pair did not settle");
          assert.ok("value" in outcome, "error" in outcome ? String(outcome.error) : undefined);
          t.diagnostic(`${side} containment: ${JSON.stringify(outcome.value)}`);
          const result = side === "submission" ? outcome.value.submissionResult : outcome.value.interactorResult;
          assert.equal(result.reason, side === "submission" ? "exited" : "process_limit", JSON.stringify(outcome.value));
          if (side === "submission") assert.equal(result.exitCode, 0, JSON.stringify(outcome.value));
          assert.equal(outcome.value.verdict, side === "submission" ? "AC" : "JE", JSON.stringify(outcome.value));
          assert.equal(outcome.value.scoreMultiplier, side === "submission" ? 1 : 0);
          assert.equal(stderr(runtime, actor),
            "parent-network/read/write/group-denied\ndescendant-network/read/write/group-denied\n",
            "No descendant denial credit is possible unless its actual attempt receipt was captured");
          assert.equal(fs.readFileSync(sentinel, "utf8"), content);
          const after = fs.lstatSync(sentinel);
          assert.equal(after.ino, before.ino);
          assert.equal(after.mode, before.mode);
          assert.equal(accepted, 0, "sandboxed participant connected to the real owned listener");
          await provePairDrained(runtime, pair, enrolled);
          await runtime.harness.shutdown();
          await waitForGenerationExclusive(runtime.generationPath, 5_000);
        } finally {
          await close(listener);
        }
        assert.ok(port > 0);
        const rebound = net.createServer((socket) => socket.destroy());
        try { await listen(rebound, port); } finally { await close(rebound); }
        assert.equal(accepted, 0);
      });
    });
    for (const row of cases) {
      await t.test(`${side} ${row.name} remains independent of its peer`, async () => {
        await guarded(async (runtime) => {
          const pair = preparePair(runtime, "resources");
          const actor = pair[side];
          const peer = pair[side === "submission" ? "interactor" : "submission"];
          if (row.fixture) actor.executableId = compileContainment(runtime, actor.runId);
          actor.args = [...row.args];
          actor.limits = { ...actor.limits, ...row.limits };
          peer.args = ["sleep-ms", "5000"];
          const peerLimits = { ...peer.limits };
          const pending = observed(startPair(runtime, pair));
          const enrolled = await registrations(runtime, pair);
          const outcome = await bounded(pending, 10_000, `${side} ${row.name} did not settle`);
          assert.ok("value" in outcome, "error" in outcome ? String(outcome.error) : undefined);
          t.diagnostic(`${side} ${row.name}: ${JSON.stringify(outcome.value)}`);
          const result = side === "submission" ? outcome.value.submissionResult : outcome.value.interactorResult;
          const peerResult = side === "submission" ? outcome.value.interactorResult : outcome.value.submissionResult;
          assert.equal(result.reason, row.reason, JSON.stringify(outcome.value));
          if (row.reason === "exited") assert.equal(result.exitCode, 0, JSON.stringify(outcome.value));
          if (row.reason !== "exited") assert.equal(peerResult.reason, "cancelled", JSON.stringify(outcome.value));
          const verdict = row.reason === "exited" ? "AC" : side === "interactor" ? "JE"
            : row.reason === "memory_limit" ? "MLE" : row.reason === "wall_time_limit" ? "TLE"
            : row.reason === "output_limit" || row.reason === "write_limit" ? "OLE" : "RTE";
          assert.equal(outcome.value.verdict, verdict, JSON.stringify(outcome.value));
          assert.equal(outcome.value.scoreMultiplier, row.reason === "exited" ? 1 : 0);
          assert.deepEqual(peer.limits, peerLimits);
          if (row.receipt) assert.equal(stderr(runtime, actor), row.receipt);
          if (row.reason === "wall_time_limit") {
            assert.ok(result.wallTimeUs >= 1_001_000 && result.wallTimeUs < 4_000_000, JSON.stringify(result));
          }
          if (row.name === "aggregate write quota" || row.name === "created-file quota") {
            assert.equal(fs.statSync(path.join(runtime.executorRoot, "workspaces", actor.workspaceId, "write-a.bin")).size, 6144);
            assert.equal(fs.statSync(path.join(runtime.executorRoot, "workspaces", actor.workspaceId, "write-b.bin")).size, 6144);
          }
          await provePairDrained(runtime, pair, enrolled);
          await runtime.harness.shutdown();
          await waitForGenerationExclusive(runtime.generationPath, 5_000);
        });
      });
    }
  }
});

function compileContainment(runtime: GateRuntime, runId: string): string {
  const compiler = "/usr/bin/clang++";
  assert.ok(fs.existsSync(compiler), "The explicit clang++ fixture compiler is unavailable");
  const output = path.join(runtime.executorRoot, "artifacts", `${runId}-containment`);
  const compilation = spawnSync(compiler, ["-std=c++17", "-O0", path.join(process.cwd(),
    "server/security-fixtures/cpp/paired_containment.cpp"), "-o", output], {
    env: sanitizedExecutorEnvironment({}), encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, compilation.stderr);
  fs.chmodSync(output, 0o500);
  return `artifacts/${runId}-containment`;
}

async function guarded(operation: (runtime: GateRuntime) => Promise<void>): Promise<void> {
  await withGateRuntime(async (runtime) => {
    try { await operation(runtime); } catch (error) { logFailureEvidence(runtime); throw error; }
  }, false);
}

function registrations(runtime: GateRuntime, pair: Parameters<typeof startPair>[1]) {
  return Promise.all([pair.submission, pair.interactor].map((actor) =>
    waitForTrace(runtime, actor.runId, "supervisor_registered")));
}

function stderr(runtime: GateRuntime, actor: Parameters<typeof startPair>[1]["submission"]): string {
  return fs.readFileSync(path.join(runtime.executorRoot, "workspaces", actor.workspaceId, actor.stderrFile), "utf8");
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", failed); resolve(); });
  });
}

function close(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
