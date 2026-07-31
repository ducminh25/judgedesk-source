import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSubmission, listContestants } from "./submission-discovery";
import { createProblemDirectoryResolver, listTestDirectories, resolveTestCaseFiles } from "./testcase-discovery";
import { discoverCustomCheckers } from "../routes/problem-routes";

test("discovery matches problem names case-insensitively and sorts tests naturally", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contestants = path.join(root, "contestants");
  const tests = path.join(root, "tests");
  fs.mkdirSync(path.join(contestants, "Alice"), { recursive: true });
  fs.writeFileSync(path.join(contestants, "Alice", "SUM.CPP"), "int main(){}", "utf8");
  for (const name of ["10", "2"]) {
    const directory = path.join(tests, "Sum", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "data.inp"), "1", "utf8");
    fs.writeFileSync(path.join(directory, "data.out"), "2", "utf8");
  }

  assert.deepEqual(listContestants(contestants, ["Alice"]), ["Alice"]);
  assert.equal(findSubmission(path.join(contestants, "Alice"), "sum")?.language, "cpp");
  assert.equal(findSubmission(path.join(contestants, "Alice"), "sum")?.problemName, "SUM");
  const problem = createProblemDirectoryResolver(tests)("SUM");
  assert.ok(problem);
  assert.deepEqual(listTestDirectories(problem.path), ["2", "10"]);
  assert.equal(resolveTestCaseFiles(problem.path, "2")?.inputFileName, "data.inp");
});

test("test discovery ignores directories without a complete input-output pair", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-testcase-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const createDirectory = (name: string): string => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };

  const test01 = createDirectory("test01");
  fs.writeFileSync(path.join(test01, "data.inp"), "");
  fs.writeFileSync(path.join(test01, "data.out"), "");

  const test02 = createDirectory("test02");
  fs.writeFileSync(path.join(test02, "sample.IN"), "1");
  fs.writeFileSync(path.join(test02, "sample.ANS"), "2");

  const pythonCache = createDirectory("__pycache__");
  fs.writeFileSync(path.join(pythonCache, "checker.cpython-312.pyc"), "cache");

  const inputOnly = createDirectory("input-only");
  fs.writeFileSync(path.join(inputOnly, "data.inp"), "1");

  const outputOnly = createDirectory("output-only");
  fs.writeFileSync(path.join(outputOnly, "data.out"), "2");

  const fakeFiles = createDirectory("fake-files");
  fs.mkdirSync(path.join(fakeFiles, "data.inp"));
  fs.mkdirSync(path.join(fakeFiles, "data.out"));

  createDirectory("empty");

  assert.deepEqual(listTestDirectories(root), ["test01", "test02"]);
  assert.equal(resolveTestCaseFiles(root, "__pycache__"), null);
  assert.equal(resolveTestCaseFiles(root, "input-only"), null);
  assert.equal(resolveTestCaseFiles(root, "output-only"), null);
  assert.equal(resolveTestCaseFiles(root, "fake-files"), null);
});

test("discovery recognizes Python submissions independently of C++", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-python-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "GRAPH.PY"), "print('ok')\n", "utf8");
  assert.deepEqual(findSubmission(root, "graph"), {
    fileName: "GRAPH.PY",
    filePath: path.join(root, "GRAPH.PY"),
    language: "python",
    problemName: "GRAPH",
  });
});

test("submission discovery maps every registered contest source extension", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-language-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    ["C_TASK.c", "c"],
    ["PASCAL_TASK.pp", "pascal"],
    ["JAVA_TASK.java", "java"],
  ] as const;
  for (const [fileName, language] of cases) {
    fs.writeFileSync(path.join(root, fileName), "");
    const problem = path.parse(fileName).name;
    assert.equal(findSubmission(root, problem)?.language, language);
  }
  for (const deferred of ["GO_TASK.go", "RUST_TASK.rs", "JS_TASK.js", "CS_TASK.cs"]) {
    fs.writeFileSync(path.join(root, deferred), "");
    assert.equal(findSubmission(root, path.parse(deferred).name), null);
  }
});

test("submission discovery fails closed when one problem has multiple languages", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-ambiguous-submission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "SUM.cpp"), "");
  fs.writeFileSync(path.join(root, "SUM.py"), "");
  assert.throws(
    () => findSubmission(root, "SUM"),
    /AMBIGUOUS_SUBMISSION.*SUM\.cpp.*SUM\.py/,
  );
});

test("submission discovery ignores candidates that are not an exact supported source file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-submission-filter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "SUM_backup.cpp"), "", "utf8");
  fs.writeFileSync(path.join(root, "SUM.txt"), "", "utf8");
  fs.mkdirSync(path.join(root, "SUM.py"));

  assert.equal(findSubmission(root, "sum"), null);
});

test("contestant discovery preserves the requested scoreboard order", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-contestant-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["C03-BaHung", "C03-khanh", "C03_QUANGMINH"]) {
    fs.mkdirSync(path.join(root, name));
  }
  assert.deepEqual(
    listContestants(root, ["C03_QUANGMINH", "C03-BaHung", "C03-khanh"]),
    ["C03_QUANGMINH", "C03-BaHung", "C03-khanh"],
  );
});

test("custom checker discovery exposes portable C++ and Python sources only", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-checker-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["checker10.py", "checker2.cpp", "legacy.exe", "notes.txt"]) {
    fs.writeFileSync(path.join(root, name), "", "utf8");
  }
  assert.deepEqual(discoverCustomCheckers(root), ["checker2.cpp", "checker10.py"]);
});
