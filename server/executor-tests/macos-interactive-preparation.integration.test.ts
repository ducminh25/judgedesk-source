import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExecutorInteractiveRunSpec } from "../executor/protocol.js";
import {
  withGateRuntime, waitForTrace, traceEvents, readTraceEvents,
  requireIdentity, assertKernelIdentity, assertExactGuardianCommand,
  assertGroupEmpty, waitForProcessGone, waitForGenerationExclusive,
  generationExclusiveAvailable, restartGateHarness,
  type GateRuntime, type InteractiveFaultPause,
} from "./macos-run-guardian.integration.test.js";
import {
  preparePair, startPair, provePairDrained, observed, bounded, logFailureEvidence,
} from "./macos-interactive-lifecycle.integration.test.js";

// These hooks are an enum-only private fault contract with a two-second native
// deadline. There are no release files, synthesized milestones, or numeric group
// signals. Use --test-name-pattern='macOS interactive preparation' because the
// imported helpers also register their original lifecycle suites.
test("macOS interactive preparation fault gate configuration", { timeout: 120_000 }, async (t) => {
  if (process.env.JUDGEDESK_RUN_GUARDIAN_FAULT_GATE !== "1") {
    t.diagnostic("Preparation faults require JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1 on Apple Silicon.");
    return;
  }
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");

  await t.test("missing second stdin after first readiness fails supervisor preparation before either GO", async () => {
    await withPreparationRuntime("second-configure", async (runtime) => {
      const pair = preparePair(runtime, "exchange-and-hold");
      pair.interactor.stdinFile = "input.txt";
      const input = path.join(runtime.executorRoot, "workspaces", pair.interactor.workspaceId, "input.txt");
      assert.equal(fs.lstatSync(input).isFile(), true);
      const pending = observed(startPair(runtime, pair));
      const [firstReady, firstEnrolled, secondPaused] = await Promise.all([
        waitForTrace(runtime, pair.submission.runId, "supervisor_ready", 5_000),
        waitForTrace(runtime, pair.submission.runId, "interactive_participant_enrolled", 5_000),
        waitForTrace(runtime, pair.interactor.runId, "interactive_second_configure_paused", 5_000),
      ]);
      assert.ok(firstReady.lineIndex < firstEnrolled.lineIndex,
        "first participant enrollment did not follow supervisor readiness");
      assert.deepEqual(requireIdentity(firstEnrolled, "anchor"), requireIdentity(firstReady, "anchor"),
        "first participant enrolled a different supervisor anchor");
      const secondGuardian = requireIdentity(secondPaused, "guardian");
      assertExactGuardianCommand(secondGuardian.pid);
      assertKernelIdentity(secondGuardian);
      assertKernelIdentity(requireIdentity(firstReady, "anchor"));
      assertKernelIdentity(requireIdentity(secondPaused, "anchor"));

      // The caller owns this regular input file. Admission has finished, the
      // first participant owns its group pin and installed stdio, and the checker
      // guardian has paused before configuring its supervisor. A missed native
      // pause window must fail instead of mutating already-configured input.
      const checkerPrepared = traceEvents(runtime.eventLog, pair.interactor.runId).filter((event) =>
        ["supervisor_ready", "guardian_started", "interactive_participant_enrolled",
          "interactive_pair_enrolled", "executor_active_committed", "guardian_go", "target_started"]
          .includes(event.event));
      assert.deepEqual(checkerPrepared, [],
        "checker configured or advanced beyond its pause before the stdin mutation");
      // Preserve the original bytes by renaming the harness-owned regular file.
      fs.renameSync(input, `${input}.removed-before-configure`);
      const outcome = await bounded(pending, 8_000,
        "second supervisor preparation did not settle after its owned stdin disappeared");
      assert.ok("value" in outcome, "error" in outcome ? String(outcome.error) : undefined);
      const result = outcome.value;
      t.diagnostic(`second-configure: ${JSON.stringify(result)}`);
      assert.equal(result.verdict, "JE", JSON.stringify(result));
      assert.equal(result.scoreMultiplier, 0, JSON.stringify(result));
      assert.equal(result.submissionResult.reason, "cancelled", JSON.stringify(result));
      assert.equal(result.interactorResult.reason, "internal_error", JSON.stringify(result));
      assert.match(result.interactorResult.diagnostic ?? "", /SUPERVISOR_INTERNAL_FAILED/);
      assert.match(result.interactorResult.diagnostic ?? "", /No such file|not found|does not exist|os error 2/i);
      assertNeverReleased(runtime, pair);
      const enrolled = await registeredPair(runtime, pair);
      await provePairDrained(runtime, pair, enrolled);
      await runtime.harness.shutdown();
      await waitForGenerationExclusive(runtime.generationPath, 5_000);
    });
  });

  await t.test("executor SIGKILL after both enrollments drains both groups without GO", async () => {
    await withPreparationRuntime("pair-commit", async (runtime) => {
      const pair = preparePair(runtime, "exchange-and-hold");
      const pending = observed(startPair(runtime, pair));
      const enrollment = await waitForPairedEnrollment(runtime, pair);
      const enrolled = await registeredPair(runtime, pair);
      const ready = await Promise.all([pair.submission, pair.interactor].map((participant) =>
        waitForTrace(runtime, participant.runId, "supervisor_ready", 5_000)));
      for (const event of ready) assertKernelIdentity(requireIdentity(event, "anchor"));
      assert.ok(ready.every((event) => event.lineIndex < enrollment.lineIndex),
        "pair-enrolled trace did not follow both trusted readiness proofs");
      assert.ok(enrolled.some((event) =>
        requireIdentity(event, "anchor").pid === requireIdentity(enrollment, "anchor").pid));
      const guardians = await Promise.all([pair.submission, pair.interactor].map((participant) =>
        waitForTrace(runtime, participant.runId, "guardian_ready", 5_000)));
      assertNeverReleased(runtime, pair);
      assert.equal(await generationExclusiveAvailable(runtime.generationPath), false);

      await runtime.harness.forceStop();
      await runtime.harness.waitForExit(5_000);
      assert.equal(runtime.harness.child.signalCode, "SIGKILL");
      const outcome = await bounded(pending, 1_000, "precommit executor death left its pair request pending");
      assert.ok("error" in outcome, "precommit SIGKILL returned a successful pair result");
      assert.match(String(outcome.error), /Native executor exited|control pipe/i);
      // The physical checks are independent of protocol acknowledgements.
      await Promise.all(enrolled.map((event) =>
        assertGroupEmpty(requireIdentity(event, "anchor").pgid)));
      await provePairDrained(runtime, pair, enrolled);
      for (const guardian of guardians) {
        await waitForTrace(runtime, guardian.runId, "guardian_cleaned", 5_000);
        await waitForProcessGone(requireIdentity(guardian, "guardian").pid, 5_000);
      }
      assertNeverReleased(runtime, pair);
      await waitForGenerationExclusive(runtime.generationPath, 5_000);
      assert.equal(runtime.harness.child.stdin.destroyed, true);
      assert.equal(runtime.harness.child.stdout.readableEnded, true);
      assert.equal(runtime.harness.child.stderr.readableEnded, true);
    });
  });

  await t.test("first spool survives executor death and startup reclaims it only after generation exclusivity", async () => {
    await withPreparationRuntime("first-spool", async (runtime) => {
      const pair = preparePair(runtime, "exchange-and-hold");
      const profiles = path.join(runtime.executorRoot, "profiles");
      const rootIdentity = fs.statSync(runtime.executorRoot, { bigint: true });
      // Guarded startup purges workspaces but preserves the managed toolchain
      // cache. Place the preservation sentinel in that cache, not a workspace.
      const sentinel = path.join(runtime.executorRoot, "toolchains", "restart-sentinel.txt");
      fs.writeFileSync(sentinel, pair.runId, { mode: 0o600, flag: "wx" });
      const pending = observed(startPair(runtime, pair));
      const created = await waitForTrace(runtime, pair.runId, "interactive_spool_created", 5_000);
      assert.equal(created.guardian, undefined);
      assert.equal(created.anchor, undefined);
      assert.equal(created.target, undefined);
      assertNoInteractiveEnrollment(runtime, pair);
      const spools = ownedSpools(runtime, pair);
      assert.equal(spools.length, 1, "first-spool hook did not precede the second spool creation");
      const spoolPath = path.join(profiles, spools[0]);
      assert.equal(fs.lstatSync(spoolPath).isFile(), true);
      assert.equal(fs.statSync(spoolPath).mode & 0o777, 0o600);

      await runtime.harness.forceStop();
      await runtime.harness.waitForExit(5_000);
      assert.equal(runtime.harness.child.signalCode, "SIGKILL");
      const outcome = await bounded(pending, 1_000, "first-spool death left the request pending");
      assert.ok("error" in outcome, "first-spool SIGKILL returned a successful pair result");
      assert.match(String(outcome.error), /Native executor exited|control pipe/i);
      assertNoInteractiveEnrollment(runtime, pair);
      assert.equal(fs.existsSync(spoolPath), true,
        "test did not preserve the interrupted first-spool artifact for startup recovery");
      await waitForGenerationExclusive(runtime.generationPath, 5_000);

      // A restart uses the same controlled TMPDIR/root and the same valid
      // generation; only after physical lease release may startup own recovery.
      await restartGateHarness(runtime);
      const restartedIdentity = fs.statSync(runtime.executorRoot, { bigint: true });
      assert.equal(restartedIdentity.dev, rootIdentity.dev);
      assert.equal(restartedIdentity.ino, rootIdentity.ino);
      assert.equal(fs.readFileSync(sentinel, "utf8"), pair.runId,
        "startup replaced managed toolchain cache data instead of preserving it");
      assert.equal(fs.existsSync(runtime.workspacePath), false,
        "guarded startup retained the previous executor workspace");
      assert.deepEqual(ownedSpools(runtime, pair), [], "startup retained the interrupted interactive spool");
      assert.equal(fs.existsSync(spoolPath), false);
      assert.equal(fs.existsSync(`${runtime.eventLog}.before-restart`), true);
      assert.equal(await generationExclusiveAvailable(runtime.generationPath), false);
      await runtime.harness.shutdown();
      await waitForGenerationExclusive(runtime.generationPath, 5_000);
    });
  });
});

function withPreparationRuntime(
  pause: InteractiveFaultPause,
  operation: (runtime: GateRuntime) => Promise<void>,
): Promise<void> {
  return withGateRuntime(async (runtime) => {
    try {
      await operation(runtime);
    } catch (error) {
      logFailureEvidence(runtime);
      throw error;
    }
  }, false, { JUDGEDESK_INTERACTIVE_FAULT_PAUSE: pause });
}

async function registeredPair(runtime: GateRuntime, pair: ExecutorInteractiveRunSpec) {
  const registered = await Promise.all([pair.submission, pair.interactor].map((participant) =>
    waitForTrace(runtime, participant.runId, "supervisor_registered", 5_000)));
  assert.notEqual(requireIdentity(registered[0], "anchor").pgid,
    requireIdentity(registered[1], "anchor").pgid);
  return registered;
}

async function waitForPairedEnrollment(runtime: GateRuntime, pair: ExecutorInteractiveRunSpec) {
  const deadline = Date.now() + 5_000;
  do {
    const enrollment = readTraceEvents(runtime.eventLog).find((event) =>
      event.generation === runtime.generation && event.event === "interactive_pair_enrolled" &&
      [pair.submission.runId, pair.interactor.runId].includes(event.runId));
    if (enrollment) return enrollment;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("neither participant emitted the trusted paired-enrollment pause milestone");
}

function assertNeverReleased(runtime: GateRuntime, pair: ExecutorInteractiveRunSpec): void {
  for (const participant of [pair.submission, pair.interactor]) {
    const releases = traceEvents(runtime.eventLog, participant.runId).filter((event) =>
      ["executor_active_committed", "guardian_go", "target_started"].includes(event.event));
    assert.deepEqual(releases, [], `preparation fault released participant ${participant.runId}`);
  }
}

function assertNoInteractiveEnrollment(runtime: GateRuntime, pair: ExecutorInteractiveRunSpec): void {
  for (const participant of [pair.submission, pair.interactor]) {
    assert.deepEqual(traceEvents(runtime.eventLog, participant.runId), [],
      `first-spool pause enrolled an interactive process for ${participant.runId}`);
  }
  const otherInteractiveEvents = readTraceEvents(runtime.eventLog).filter((event) =>
    event.generation === runtime.generation && event.runId.startsWith("interactive_") &&
    event.runId !== pair.runId);
  assert.deepEqual(otherInteractiveEvents, [], "first-spool reproduction was not otherwise idle");
}

function ownedSpools(runtime: GateRuntime, pair: ExecutorInteractiveRunSpec): string[] {
  return fs.readdirSync(path.join(runtime.executorRoot, "profiles"))
    .filter((name) => name.endsWith(".interactive") &&
      [pair.submission, pair.interactor].some((participant) => name.startsWith(`${participant.runId}-`)));
}
