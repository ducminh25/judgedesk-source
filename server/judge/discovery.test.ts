import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isTextFile, readTextPreview } from "../file-utils.js";
import { createSubmissionResolver, findSubmission, listContestants } from "./submission-discovery.js";
import {
  createProblemDirectoryResolver,
  discoverTestCases,
  listTestDirectories,
  resolveTestCaseFiles,
} from "./testcase-discovery.js";
import { discoverCustomCheckers, discoverInteractors } from "../routes/problem-routes.js";

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

test("submission resolver snapshots one contestant directory for the whole session", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-submission-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "SUM.cpp"), "");
  const resolveSubmission = createSubmissionResolver(root);

  fs.writeFileSync(path.join(root, "SUM.py"), "");
  assert.equal(resolveSubmission("sum")?.fileName, "SUM.cpp");
  assert.throws(
    () => createSubmissionResolver(root)("SUM"),
    /AMBIGUOUS_SUBMISSION.*SUM\.cpp.*SUM\.py/,
  );
});

test("testcase index returns naturally sorted resolved file pairs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-testcase-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["10", "2"]) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "case.in"), name);
    fs.writeFileSync(path.join(directory, "case.ans"), name);
  }

  const indexed = discoverTestCases(root);
  assert.deepEqual(indexed.map(testCase => testCase.name), ["2", "10"]);
  assert.equal(indexed[0].inputPath, path.join(root, "2", "case.in"));
  assert.equal(indexed[0].outputPath, path.join(root, "2", "case.ans"));
});

test("bounded text inspection preserves binary detection and output previews", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-file-inspection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const text = path.join(root, "text.in");
  const binary = path.join(root, "binary.in");
  const output = path.join(root, "answer.out");
  fs.writeFileSync(text, "x".repeat(1024 * 1024));
  fs.writeFileSync(binary, Buffer.from([65, 0, 66]));
  fs.writeFileSync(output, "ấ".repeat(600), "utf8");

  assert.equal(isTextFile(text), true);
  assert.equal(isTextFile(binary), false);
  assert.equal(readTextPreview(output), `${"ấ".repeat(500)}...`);
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

test("custom checker discovery discovers and prioritizes .exe on Windows and source on macOS", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-checker-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["checker10.py", "checker2.cpp", "legacy.exe", "alpha.exe", "notes.txt"]) {
    fs.writeFileSync(path.join(root, name), "", "utf8");
  }
  assert.deepEqual(discoverCustomCheckers(root, "win32"), ["alpha.exe", "legacy.exe", "checker2.cpp", "checker10.py"]);
  assert.deepEqual(discoverCustomCheckers(root, "darwin"), ["checker2.cpp", "checker10.py"]);
});

test("interactor discovery discovers and sorts interactors across platforms", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-interactor-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["interactor.cpp", "interactor2.py", "interactor.exe", "interactor_custom.exe", "notes.txt"]) {
    fs.writeFileSync(path.join(root, name), "", "utf8");
  }
  assert.deepEqual(discoverInteractors(root, "win32"), ["interactor_custom.exe", "interactor.exe", "interactor.cpp", "interactor2.py"]);
  assert.deepEqual(discoverInteractors(root, "darwin"), ["interactor.cpp", "interactor2.py"]);
});

test("testcase discovery for interactive problem allows input-only directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-interactive-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const test01 = path.join(root, "test01");
  fs.mkdirSync(test01, { recursive: true });
  fs.writeFileSync(path.join(test01, "data.inp"), "42", "utf8");

  // Non-interactive ignores input-only test
  assert.deepEqual(discoverTestCases(root, false), []);

  // Interactive accepts input-only test
  const testcases = discoverTestCases(root, true);
  assert.equal(testcases.length, 1);
  assert.equal(testcases[0].name, "test01");
  assert.equal(testcases[0].inputFileName, "data.inp");
  assert.equal(testcases[0].outputPath, "");
});
