import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import express from "express";
import { registerProblemRoutes } from "./problem-routes.js";

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-problem-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  registerProblemRoutes(app);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { root, url: `http://127.0.0.1:${address.port}` };
}

test("direct flat problem import tolerates auxiliary directories and previews the same pairs", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(path.join(problem, "__pycache__"), { recursive: true });
  fs.mkdirSync(path.join(problem, "docs"));
  fs.writeFileSync(path.join(problem, "test1.inp"), "1 2\n");
  fs.writeFileSync(path.join(problem, "test1.out"), "3\n");
  fs.writeFileSync(path.join(problem, "test2.in"), "4 5\n");
  fs.writeFileSync(path.join(problem, "test2.ans"), "9\n");

  const imported = await fetch(`${url}/api/fetch-problems?path=${encodeURIComponent(problem)}`);
  assert.deepEqual(await imported.json(), {
    success: true, data: ["SUM"], customCheckers: { SUM: [] }, interactors: { SUM: [] },
  });
  const syntheticPath = path.join(problem, "SUM");
  const tests = await fetch(`${url}/api/fetch-tests?path=${encodeURIComponent(syntheticPath)}`);
  assert.equal(tests.status, 200);
  assert.deepEqual(await tests.json(), { success: true, data: ["test1", "test2"] });
  const previews = await fetch(`${url}/api/fetch-polygon-tests?path=${encodeURIComponent(syntheticPath)}&problem=SUM`);
  assert.equal(previews.status, 200);
  assert.deepEqual(await previews.json(), {
    success: true,
    data: [{ name: "test1", preview: "1 2\n", size: 4 }, { name: "test2", preview: "4 5\n", size: 4 }],
  });
});

test("direct flat problem config reads and writes its own directory", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(problem);
  fs.writeFileSync(path.join(problem, "test1.inp"), "1");
  fs.writeFileSync(path.join(problem, "test1.out"), "2");
  const original = { totalScore: 75 };
  fs.writeFileSync(path.join(problem, "Config.cfg"), JSON.stringify(original));
  const syntheticPath = path.join(problem, "SUM");
  const read = await fetch(`${url}/api/polygon-config?path=${encodeURIComponent(syntheticPath)}`);
  assert.deepEqual(await read.json(), { success: true, data: original });

  const write = await fetch(`${url}/api/polygon-config`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: syntheticPath, config: { totalScore: 100 } }),
  });
  assert.equal(write.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(problem, "Config.cfg"), "utf8")).totalScore, 100);
  assert.equal(fs.existsSync(syntheticPath), false);
});

test("well-formed preview never writes Config.cfg; invalid save is atomic", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(problem);
  fs.writeFileSync(path.join(problem, "1.inp"), "1  2\n");
  fs.writeFileSync(path.join(problem, "1.out"), "3\n");
  const configPath = path.join(problem, "Config.cfg");
  fs.writeFileSync(configPath, JSON.stringify({ totalScore: 99 }));
  const original = fs.readFileSync(configPath, "utf8");
  const post = (validateOnly: boolean) => fetch(`${url}/api/polygon-config`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: problem, config: { testWellFormed: true, totalScore: 1 }, validateOnly }),
  });
  const preview = await post(true);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.data.issues[0].code, "consecutive_spaces");
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  const rejected = await post(false);
  assert.equal(rejected.status, 422);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  fs.writeFileSync(path.join(problem, "1.inp"), "1 2\n");
  const accepted = await post(false);
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).testWellFormed, true);
});

test("missing problem paths never read or overwrite the parent configuration", async t => {
  const { root, url } = await setup(t);
  const configPath = path.join(root, "Config.cfg");
  const original = JSON.stringify({ totalScore: 75 });
  fs.writeFileSync(configPath, original);
  const missing = path.join(root, "MissingProblem");
  const read = await fetch(`${url}/api/polygon-config?path=${encodeURIComponent(missing)}`);
  assert.deepEqual(await read.json(), { success: true, data: null });
  const write = await fetch(`${url}/api/polygon-config`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: missing, config: { totalScore: 100 } }),
  });
  assert.equal(write.status, 500);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("parent folder import retains both flat and Themis problem directories", async t => {
  const { root, url } = await setup(t);
  fs.mkdirSync(path.join(root, "SUM"));
  fs.writeFileSync(path.join(root, "SUM", "test1.inp"), "1");
  fs.writeFileSync(path.join(root, "SUM", "test1.out"), "2");
  fs.mkdirSync(path.join(root, "MAX", "Test01"), { recursive: true });
  fs.writeFileSync(path.join(root, "MAX", "Test01", "MAX.INP"), "1");
  fs.writeFileSync(path.join(root, "MAX", "Test01", "MAX.OUT"), "2");
  const imported = await fetch(`${url}/api/fetch-problems?path=${encodeURIComponent(root)}`);
  assert.deepEqual(await imported.json(), {
    success: true, data: ["MAX", "SUM"], customCheckers: { MAX: [], SUM: [] }, interactors: { MAX: [], SUM: [] },
  });
});

test("complete flat pairs remain importable alongside input-only auxiliary data", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(path.join(problem, "generator"), { recursive: true });
  fs.writeFileSync(path.join(problem, "generator", "example.in"), "sample");
  fs.writeFileSync(path.join(problem, "test1.inp"), "1");
  fs.writeFileSync(path.join(problem, "test1.out"), "2");
  const imported = await fetch(`${url}/api/fetch-problems?path=${encodeURIComponent(problem)}`);
  assert.deepEqual(await imported.json(), {
    success: true, data: ["SUM"], customCheckers: { SUM: [] }, interactors: { SUM: [] },
  });
});

test("direct flat config and tests ignore a same-name auxiliary child", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  const syntheticPath = path.join(problem, "SUM");
  fs.mkdirSync(path.join(syntheticPath, "docs"), { recursive: true });
  fs.writeFileSync(path.join(problem, "1.inp"), "1");
  fs.writeFileSync(path.join(problem, "1.out"), "2");
  const original = { totalScore: 75 };
  fs.writeFileSync(path.join(problem, "Config.cfg"), JSON.stringify(original));
  const tests = await fetch(`${url}/api/fetch-tests?path=${encodeURIComponent(syntheticPath)}`);
  assert.deepEqual(await tests.json(), { success: true, data: ["1"] });
  const read = await fetch(`${url}/api/polygon-config?path=${encodeURIComponent(syntheticPath)}`);
  assert.deepEqual(await read.json(), { success: true, data: original });
});

test("a dangling same-name link cannot redirect config writes to the flat parent", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(problem);
  fs.writeFileSync(path.join(problem, "1.inp"), "1");
  fs.writeFileSync(path.join(problem, "1.out"), "2");
  const configPath = path.join(problem, "Config.cfg");
  const original = JSON.stringify({ totalScore: 75 });
  fs.writeFileSync(configPath, original);
  const linkedPath = path.join(problem, "SUM");
  fs.symlinkSync(path.join(root, "missing-target"), linkedPath, "junction");
  const write = await fetch(`${url}/api/polygon-config`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: linkedPath, config: { totalScore: 100 } }),
  });
  assert.equal(write.status, 500);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("a real same-name child keeps its own tests and config despite root sample files", async t => {
  const { root, url } = await setup(t);
  for (const name of ["SUM", "CHAT"]) {
    const container = path.join(root, name);
    const problem = path.join(container, name);
    fs.mkdirSync(problem, { recursive: true });
    fs.writeFileSync(path.join(container, "sample.inp"), "sample");
    fs.writeFileSync(path.join(container, "sample.out"), "sample");
    if (name === "SUM") {
      fs.mkdirSync(path.join(problem, "Test01"));
      fs.writeFileSync(path.join(problem, "Test01", "data.inp"), "official");
      fs.writeFileSync(path.join(problem, "Test01", "data.out"), "answer");
    } else {
      fs.writeFileSync(path.join(problem, "1.in"), "interactive");
    }
    const config = { totalScore: 75, isInteractive: name === "CHAT" };
    fs.writeFileSync(path.join(problem, "Config.cfg"), JSON.stringify(config));
    const tests = await fetch(`${url}/api/fetch-tests?path=${encodeURIComponent(problem)}`);
    assert.deepEqual(await tests.json(), { success: true, data: [name === "SUM" ? "Test01" : "1"] });
    const read = await fetch(`${url}/api/polygon-config?path=${encodeURIComponent(problem)}`);
    assert.deepEqual(await read.json(), { success: true, data: config });
  }
});

test("an extensionless same-name binary does not block direct flat test import", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(problem);
  fs.writeFileSync(path.join(problem, "1.inp"), "1");
  fs.writeFileSync(path.join(problem, "1.out"), "2");
  const syntheticPath = path.join(problem, "SUM");
  fs.writeFileSync(syntheticPath, "compiled executable");
  const tests = await fetch(`${url}/api/fetch-tests?path=${encodeURIComponent(syntheticPath)}`);
  assert.equal(tests.status, 200);
  assert.deepEqual(await tests.json(), { success: true, data: ["1"] });
});

test("nested input-only auxiliary examples do not mask a normal flat problem", async t => {
  const { root, url } = await setup(t);
  const problem = path.join(root, "SUM");
  fs.mkdirSync(path.join(problem, "generator", "examples"), { recursive: true });
  fs.writeFileSync(path.join(problem, "generator", "examples", "example.in"), "example");
  fs.writeFileSync(path.join(problem, "test1.inp"), "1");
  fs.writeFileSync(path.join(problem, "test1.out"), "2");
  const imported = await fetch(`${url}/api/fetch-problems?path=${encodeURIComponent(problem)}`);
  assert.deepEqual(await imported.json(), {
    success: true, data: ["SUM"], customCheckers: { SUM: [] }, interactors: { SUM: [] },
  });
});

test("fetch-problems creates default Config.cfg on first import and reconciles when test count changes", async t => {
  const { root, url } = await setup(t);
  const mexDir = path.join(root, "MEXARRAY");
  const sumDir = path.join(root, "SUM");
  fs.mkdirSync(path.join(mexDir, "Test01"), { recursive: true });
  fs.mkdirSync(path.join(mexDir, "Test02"), { recursive: true });
  fs.writeFileSync(path.join(mexDir, "Test01", "MEXARRAY.inp"), "1\n");
  fs.writeFileSync(path.join(mexDir, "Test01", "MEXARRAY.out"), "1\n");
  fs.writeFileSync(path.join(mexDir, "Test02", "MEXARRAY.inp"), "2\n");
  fs.writeFileSync(path.join(mexDir, "Test02", "MEXARRAY.out"), "2\n");
  fs.writeFileSync(path.join(mexDir, "lcmp.cpp"), "int main(){}");

  fs.mkdirSync(path.join(sumDir, "Test01"), { recursive: true });
  fs.writeFileSync(path.join(sumDir, "Test01", "SUM.inp"), "1\n");
  fs.writeFileSync(path.join(sumDir, "Test01", "SUM.out"), "1\n");

  const imported = await fetch(`${url}/api/fetch-problems?path=${encodeURIComponent(root)}`);
  assert.equal(imported.status, 200);
  assert.equal(fs.existsSync(path.join(mexDir, "Config.cfg")), true);
  assert.equal(fs.existsSync(path.join(sumDir, "Config.cfg")), true);

  const mexCfg = JSON.parse(fs.readFileSync(path.join(mexDir, "Config.cfg"), "utf8"));
  assert.equal(mexCfg.checkerType, "lcmp.cpp");
  assert.equal(mexCfg.totalScore, null);
  assert.equal(mexCfg.defaultScore, 1);

  const sumCfg = JSON.parse(fs.readFileSync(path.join(sumDir, "Config.cfg"), "utf8"));
  assert.equal(sumCfg.checkerType, "C1");

  // Save a config with 2 tests (45 pts each, totalScore="90") and explicit checkerType="C1"
  await fetch(`${url}/api/polygon-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: mexDir,
      config: {
        ...mexCfg,
        checkerType: "C1",
        totalScore: "90",
        tests: { Test01: { points: 45 }, Test02: { points: 45 } },
        testScores: { Test01: 45, Test02: 45 },
      },
    }),
  });

  // Add Test03 on disk and re-fetch problems -> Config.cfg reconciles to 3 tests of 30 pts each
  fs.mkdirSync(path.join(mexDir, "Test03"), { recursive: true });
  fs.writeFileSync(path.join(mexDir, "Test03", "MEXARRAY.inp"), "3\n");
  fs.writeFileSync(path.join(mexDir, "Test03", "MEXARRAY.out"), "3\n");

  await fetch(`${url}/api/fetch-problems?path=${encodeURIComponent(root)}`);
  const reconciled = JSON.parse(fs.readFileSync(path.join(mexDir, "Config.cfg"), "utf8"));
  assert.equal(reconciled.checkerType, "C1");
  assert.equal(reconciled.totalScore, "90");
  assert.deepEqual(reconciled.tests, {
    Test01: { points: 30 },
    Test02: { points: 30 },
    Test03: { points: 30 },
  });
  assert.deepEqual(reconciled.testScores, {
    Test01: 30,
    Test02: 30,
    Test03: 30,
  });
});
