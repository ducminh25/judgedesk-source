import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OsdService } from "./osd-service.js";
import { sharedJudgeSessionGate } from "./resource-policy.js";
import type { OsdConfig } from "./osd-types.js";
import type { ProblemConfig } from "../types.js";
import type { runTestCase } from "./testcase-runner.js";

const problem: ProblemConfig = { useStdIO: true, totalScore: null, defaultScore: "1/3", testScores: {} };

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; ++attempt) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "OSD did not reach the expected lifecycle state");
}

function fixture(run?: typeof runTestCase, ready = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-osd-service-"));
  const config: OsdConfig = { osdPath: path.join(root, "osd"), contestantsPath: path.join(root, "contestants"), testPath: path.join(root, "tests"), pollIntervalMs: 60_000 };
  for (const directory of [config.osdPath, config.contestantsPath, config.testPath]) fs.mkdirSync(directory);
  for (const name of ["Test01", "Test02"]) {
    const directory = path.join(config.testPath, "SUM", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SUM.inp"), "1\n");
    fs.writeFileSync(path.join(directory, "SUM.out"), "1\n");
  }
  const calls: Parameters<typeof runTestCase>[0][] = [];
  const service = new OsdService({
    resolveCompilationToolchain: async kind => ({ kind, source: "none", ready, executablePath: "test-boundary-only", version: "fixture" }),
    compileSubmission: async () => ({ compileStatus: "OK", compileError: "", compileTime: 0, executablePath: "test-boundary-only" }),
    resolveChecker: async () => undefined,
    runTestCase: async options => {
      calls.push(options);
      return run ? run(options) : { name: options.testName, status: "AC", executionTime: 1, score: options.score, scoreExact: options.scoreExact };
    },
  });
  return { root, config, service, calls };
}

describe("OSD accepted-job lifecycle", () => {
  it("a new contest without request overrides does not inherit the previous contest scoring", async () => {
    const f = fixture();
    try {
      f.service.start(f.config, { SUM: problem });
      f.service.stop();
      const nextRoot = path.join(f.root, "next-tests");
      fs.cpSync(f.config.testPath, nextRoot, { recursive: true });
      fs.writeFileSync(path.join(nextRoot, "SUM", "Config.cfg"), JSON.stringify({ useStdIO: true }));
      assert.equal(f.service.start({ ...f.config, testPath: nextRoot }).success, true);
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "A");
      await until(() => f.service.getStatus().totalProcessed === 1);
      assert.deepEqual(f.service.getStatus().lastProcessedJob?.result?.summary.scoreExact, { n: 2, d: 1 });
    } finally {
      f.service.stop();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retries owned-leaf cleanup on the next start after a transient cleanup failure", async () => {
    let stray = "";
    const f = fixture(async options => {
      stray = path.join(path.dirname(options.submissionPath), "host-retained-file");
      fs.writeFileSync(stray, "simulate a temporarily nonempty owned leaf");
      return { name: options.testName, status: "AC", executionTime: 1, score: options.score, scoreExact: options.scoreExact };
    });
    try {
      f.service.start(f.config, { SUM: problem });
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "A");
      await until(() => f.service.getStatus().totalProcessed === 1);
      f.service.stop();
      assert.equal(f.service.start(f.config).success, false);
      fs.unlinkSync(stray);
      assert.equal(f.service.start(f.config).success, true, "a transient cleanup error must not permanently lock the service");
    } finally {
      f.service.stop();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses restart until stopped intake claims have finished rollback", async () => {
    const f = fixture();
    try {
      f.service.start(f.config, { SUM: problem });
      f.service.pause();
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "A");
      await until(() => fs.readdirSync(f.config.osdPath).some(entry => entry.startsWith(".judgedesk-osd-")));
      f.service.stop();
      assert.equal(f.service.start(f.config).success, false, "a stopped but pending claim still owns a rollback");
      await until(() => !fs.readdirSync(f.config.osdPath).some(entry => entry.startsWith(".judgedesk-osd-")));
      assert.equal(f.service.start(f.config).success, true);
    } finally {
      f.service.stop();
      await until(() => !f.service.getStatus().currentJob && !fs.readdirSync(f.config.osdPath).some(entry => entry.startsWith(".judgedesk-osd-")));
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not publish an obsolete accepted job over the later submission", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async options => {
      const latest = fs.readFileSync(options.submissionPath, "utf8") === "B";
      if (latest) await blocked;
      return { name: options.testName, status: latest ? "WA" : "AC", executionTime: 1,
        score: latest ? 0 : options.score, scoreExact: latest ? { n: 0, d: 1 } : options.scoreExact };
    });
    try {
      f.service.start(f.config, { SUM: problem });
      f.service.pause();
      const name = "0[HS01][SUM]cpp";
      fs.writeFileSync(path.join(f.config.osdPath, name), "A");
      await until(() => f.service.getStatus().queueLength === 1);
      fs.writeFileSync(path.join(f.config.osdPath, name), "B");
      await until(() => f.service.getStatus().queueLength === 2);
      f.service.stop();
      await until(() => f.calls.length === 3);
      assert.equal(fs.existsSync(path.join(f.config.osdPath, "logs", `${name}.log`)), false, "superseded job must not publish its old score");
      release?.();
      await until(() => f.service.getStatus().totalProcessed === 2);
      assert.notEqual(f.calls[0].submissionPath, f.calls[2].submissionPath);
      assert.deepEqual(f.calls.map(call => call.scoreExact), Array(4).fill({ n: 1, d: 3 }));
      assert.match(fs.readFileSync(path.join(f.config.osdPath, "logs", `${name}.log`), "utf8"), /^HS01‣SUM: 0\.000000/);
      assert.equal(fs.readdirSync(f.config.osdPath).some(entry => entry.startsWith(".judgedesk-osd-")), false);
    } finally {
      release?.();
      f.service.stop();
      await until(() => !f.service.getStatus().currentJob);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("mixed AC and JE fails the whole job rather than publishing a numeric partial award", async () => {
    const f = fixture(async options => ({ name: options.testName, status: options.testName === "Test01" ? "AC" : "JE", executionTime: 0,
      score: options.testName === "Test01" ? options.score : 0, scoreExact: options.scoreExact, errorDetail: "runner unavailable" }));
    try {
      f.service.start(f.config, { SUM: problem });
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "A");
      await until(() => f.service.getStatus().totalProcessed === 1);
      assert.equal(f.service.getStatus().lastProcessedJob?.status, "failed");
      assert.equal(f.service.getStatus().lastProcessedJob?.result, undefined);
      assert.match(fs.readFileSync(path.join(f.config.osdPath, "logs", "0[HS01][SUM]cpp.log"), "utf8"), /^HS01‣SUM: ℱ Lỗi hệ thống chấm/);
    } finally {
      f.service.stop();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a new session while accepted jobs are paused or draining", async () => {
    const f = fixture();
    assert.ok(sharedJudgeSessionGate.tryAcquire());
    try {
      assert.equal(f.service.start(f.config, { SUM: problem }).success, true);
      f.service.pause();
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "source A");
      await until(() => f.service.getStatus().queueLength === 1);
      const response = f.service.start(f.config);
      assert.equal(response.success, false);
      assert.match(response.message ?? "", /hàng đợi|chấm/i);
    } finally {
      f.service.stop();
      sharedJudgeSessionGate.release();
      await until(() => f.service.getStatus().totalProcessed === 1);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("stopping intake drains every testcase and pins the accepted problem config", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async options => {
      if (options.testName === "Test01") await blocked;
      return { name: options.testName, status: "AC", executionTime: 1, score: options.score, scoreExact: options.scoreExact };
    });
    try {
      assert.equal(f.service.start(f.config, { SUM: problem }).success, true);
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "source A");
      await until(() => f.calls.length === 1);
      f.service.stop();
      f.service.updateProblemConfigs({ SUM: { ...problem, defaultScore: 99 } });
      assert.equal(f.service.start(f.config).success, false);
      release?.();
      await until(() => f.service.getStatus().totalProcessed === 1);
      assert.equal(f.service.getStatus().lastProcessedJob?.result?.testCases.length, 2);
      assert.deepEqual(f.calls.map(call => call.scoreExact), [{ n: 1, d: 3 }, { n: 1, d: 3 }]);
      assert.deepEqual(f.service.getStatus().lastProcessedJob?.result?.summary.scoreExact, { n: 2, d: 3 });
      assert.match(fs.readFileSync(path.join(f.config.osdPath, "logs", "0[HS01][SUM]cpp.log"), "utf8"), /^HS01‣SUM: 0\.666667/);
      assert.equal(fs.existsSync(f.calls[0].submissionPath), false, "owned source must be released after a terminal job");
      assert.equal(f.service.start(f.config).success, true);
    } finally {
      release?.();
      f.service.stop();
      await until(() => !f.service.getStatus().currentJob);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("a missing host compiler is a failed job and nonnumeric infrastructure log, never student CE", async () => {
    const f = fixture(undefined, false);
    try {
      f.service.start(f.config, { SUM: problem });
      fs.writeFileSync(path.join(f.config.osdPath, "0[HS01][SUM]cpp"), "source A");
      await until(() => f.service.getStatus().totalProcessed === 1);
      const job = f.service.getStatus().lastProcessedJob;
      assert.equal(job?.status, "failed");
      assert.equal(job?.result, undefined);
      assert.match(fs.readFileSync(path.join(f.config.osdPath, "logs", "0[HS01][SUM]cpp.log"), "utf8"), /^HS01‣SUM: ℱ Lỗi hệ thống chấm/);
      assert.equal(f.calls.length, 0);
    } finally {
      f.service.stop();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
