import assert from "node:assert/strict";
import test from "node:test";
import { ToolchainMaintenanceGate } from "./maintenance-gate.js";

test("toolchain maintenance and judge leases are mutually exclusive", () => {
  const gate = new ToolchainMaintenanceGate(() => 0);
  const judge = gate.tryAcquireJudge("judge-1");
  assert.ok(judge);
  assert.equal(gate.tryAcquire("certify-while-judging"), null);
  judge.finish();

  const maintenance = gate.tryAcquire("certify-1");
  assert.ok(maintenance);
  assert.equal(gate.tryAcquireJudge("judge-while-certifying"), null);
  maintenance.finish();

  const nextJudge = gate.tryAcquireJudge("judge-2");
  assert.ok(nextJudge);
  nextJudge.finish();
});

test("toolchain maintenance observes judge sessions admitted by the lifecycle", () => {
  let activeSessions = 1;
  const gate = new ToolchainMaintenanceGate(() => activeSessions);
  assert.equal(gate.tryAcquire("certify-1"), null);
  activeSessions = 0;
  const maintenance = gate.tryAcquire("certify-2");
  assert.ok(maintenance);
  maintenance.finish();
});
