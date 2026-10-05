import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExecutorInteractiveRunSpec } from "../executor/protocol.js";
import {
  preparePair, startPair, bounded, logFailureEvidence,
} from "./macos-interactive-lifecycle.integration.test.js";
import {
  withGateRuntime, traceEvents, assertNoRunProfileArtifacts,
  waitForGenerationExclusive, gateId, type GateRuntime,
} from "./macos-run-guardian.integration.test.js";

interface AdmissionCase {
  name: string;
  mutate: (pair: ExecutorInteractiveRunSpec, runtime: GateRuntime) => void;
  diagnostic: RegExp;
  protocolError?: string;
}

// Ten refusal categories. Side-specific cases are separate actual requests, so
// a first participant's rejection cannot stand in for testing the second side.
const cases: AdmissionCase[] = [
  {
    name: "wrong submission role",
    mutate: (pair) => { pair.submission.role = "checker"; },
    diagnostic: /interactive participants require submission and checker roles/,
  },
  {
    name: "wrong interactor role",
    mutate: (pair) => { pair.interactor.role = "submission"; },
    diagnostic: /interactive participants require submission and checker roles/,
  },
  {
    name: "duplicate participant workspaces",
    mutate: (pair) => { pair.interactor.workspaceId = pair.submission.workspaceId; },
    diagnostic: /interactive participants require distinct workspaces/,
  },
  {
    name: "duplicate participant run IDs",
    mutate: (pair) => { pair.interactor.runId = pair.submission.runId; },
    diagnostic: /duplicate runId/,
    protocolError: "SECURE_RUNNER_INVALID_REQUEST: duplicate runId",
  },
];

for (const side of ["submission", "interactor"] as const) {
  cases.push(
    {
      name: `${side} executable path traversal`,
      mutate: (pair) => { pair[side].executableId = `../${pair[side].executableId}`; },
      diagnostic: /path must be a normalized relative path/,
    },
    {
      name: `${side} absolute external executable`,
      mutate: (pair, runtime) => {
        const actor = pair[side];
        const external = path.join(runtime.directory, `${actor.runId}-external-executable`);
        // Copy a known owned regular test fixture, without changing the shared
        // artifact or granting access to the external copy. No ambient path is written.
        fs.copyFileSync(path.join(runtime.executorRoot, actor.executableId), external, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(external, 0o500);
        actor.executableId = external;
      },
      diagnostic: /path must be a normalized relative path/,
    },
    {
      name: `${side} missing owned workspace`,
      mutate: (pair, runtime) => {
        const missing = gateId("absent_workspace");
        assert.equal(fs.existsSync(path.join(runtime.executorRoot, "workspaces", missing)), false);
        pair[side].workspaceId = missing;
      },
      diagnostic: /workspace unavailable:.*(?:No such file|not found|os error 2)/i,
    },
    {
      name: `${side} missing owned executable source`,
      mutate: (pair, runtime) => {
        const missing = `artifacts/${gateId("absent_executable")}`;
        assert.equal(fs.existsSync(path.join(runtime.executorRoot, missing)), false);
        pair[side].executableId = missing;
      },
      diagnostic: /path unavailable:.*(?:No such file|not found|os error 2)/i,
    },
    {
      name: `${side} malformed stdout path`,
      mutate: (pair) => { pair[side].stdoutFile = "../outside-output.txt"; },
      diagnostic: /workspace file path is not normalized/,
    },
  );
  for (const key of ["JUDGEDESK_INTERACTIVE_FAULT_PAUSE", "DYLD_INSERT_LIBRARIES"] as const) {
    cases.push({
      name: `${side} reserved ${key} environment injection`,
      mutate: (pair) => {
        pair[side].environment[key] = key === "JUDGEDESK_INTERACTIVE_FAULT_PAUSE"
          ? "pair-commit" : "/not-loaded-reserved-fixture.dylib";
      },
      diagnostic: /environment contains a variable reserved by the secure executor/,
    });
  }
}

// Focus --test-name-pattern='macOS interactive admission'. Shared imports also
// register lifecycle/guardian suites; their gates must not run in this window.
test("macOS interactive admission refusal gate configuration", { timeout: 180_000 }, async (t) => {
  if (process.env.JUDGEDESK_INTERACTIVE_ADMISSION_GATE !== "1") {
    t.diagnostic("Admission refusals require JUDGEDESK_INTERACTIVE_ADMISSION_GATE=1 and the owned guardian gate on Apple Silicon.");
    return;
  }
  assert.equal(process.env.JUDGEDESK_RUN_GUARDIAN_FAULT_GATE, "1");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  for (const row of cases) {
    await t.test(`${row.name} refuses before spool creation or participant enrollment`, async () => {
      await withGateRuntime(async (runtime) => {
        try {
          const pair = preparePair(runtime, "normal-exchange");
          const originalIds = [pair.runId, pair.submission.runId, pair.interactor.runId];
          const profiles = path.join(runtime.executorRoot, "profiles");
          const beforeProfiles = fs.readdirSync(profiles).sort();
          row.mutate(pair, runtime);
          if (row.protocolError) {
            // main.rs rejects duplicate IDs before dispatching a paired worker.
            // The harness maps the framed error response to this exact Error.
            await assert.rejects(bounded(runtime.harness.request({
              type: "interactive_run", id: crypto.randomUUID(), spec: pair,
            }, 5_000), 5_000, `${row.name} did not settle at admission`), (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.equal(error.message, row.protocolError);
              return true;
            });
            t.diagnostic(`${row.name}: ${row.protocolError}`);
          } else {
            const result = await bounded(startPair(runtime, pair), 5_000, `${row.name} did not settle at admission`);
            t.diagnostic(`${row.name}: ${JSON.stringify(result)}`);
            assert.equal(result.verdict, "JE", JSON.stringify(result));
            assert.equal(result.scoreMultiplier, 0, JSON.stringify(result));
            assert.match(result.message ?? "", row.diagnostic, JSON.stringify(result));
            for (const actor of [result.submissionResult, result.interactorResult]) {
              assert.equal(actor.reason, "internal_error", JSON.stringify(result));
              assert.equal(actor.exitCode, null, JSON.stringify(result));
              assert.equal(actor.stdoutBytes, 0, JSON.stringify(result));
              assert.equal(actor.stderrBytes, 0, JSON.stringify(result));
            }
          }
          const ids = new Set([...originalIds, pair.runId, pair.submission.runId, pair.interactor.runId]);
          for (const runId of ids) {
            // Startup self-test has its own authenticated run IDs and is excluded.
            // Every phase for this actual pair, including spool-created, is forbidden.
            assert.deepEqual(traceEvents(runtime.eventLog, runId), [],
              `admission refusal enrolled or prepared native state for ${runId}`);
            assertNoRunProfileArtifacts(runtime, runId);
          }
          assert.deepEqual(fs.readdirSync(profiles).sort(), beforeProfiles,
            "admission refusal changed trusted profile/spool inventory");
          assert.deepEqual(fs.readdirSync(profiles).filter((name) => name.endsWith(".interactive")), [],
            "admission refusal retained an interactive capture");
          await runtime.harness.shutdown();
          await waitForGenerationExclusive(runtime.generationPath, 5_000);
        } catch (error) {
          logFailureEvidence(runtime);
          throw error;
        }
      }, false);
    });
  }
});
