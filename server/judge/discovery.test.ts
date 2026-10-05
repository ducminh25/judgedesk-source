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

test("flat test discovery discovers x.inp and x.out pairs in a single folder naturally sorted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-flat-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "1.inp"), "10");
  fs.writeFileSync(path.join(root, "1.out"), "20");
  fs.writeFileSync(path.join(root, "2.INP"), "30");
  fs.writeFileSync(path.join(root, "2.OUT"), "40");
  fs.writeFileSync(path.join(root, "10.inp"), "50");
  fs.writeFileSync(path.join(root, "10.out"), "60");
  fs.writeFileSync(path.join(root, "case-a.in"), "70");
  fs.writeFileSync(path.join(root, "case-a.ans"), "80");
  fs.writeFileSync(path.join(root, "incomplete.inp"), "90");
  fs.writeFileSync(path.join(root, "orphan.out"), "100");
  fs.writeFileSync(path.join(root, "solution.cpp"), "int main(){}");
  fs.writeFileSync(path.join(root, "Config.cfg"), "{}");

  assert.deepEqual(listTestDirectories(root), ["1", "2", "10", "case-a"]);

  const discovered = discoverTestCases(root);
  assert.equal(discovered.length, 4);
  assert.equal(discovered[0].name, "1");
  assert.equal(discovered[0].inputPath, path.join(root, "1.inp"));
  assert.equal(discovered[0].outputPath, path.join(root, "1.out"));
  assert.equal(discovered[0].inputFileName, "1.inp");
  assert.equal(discovered[0].directory, root);

  assert.equal(discovered[1].name, "2");
  assert.equal(discovered[1].inputPath, path.join(root, "2.INP"));
  assert.equal(discovered[1].outputPath, path.join(root, "2.OUT"));
  assert.equal(discovered[1].inputFileName, "2.INP");

  assert.equal(discovered[2].name, "10");
  assert.equal(discovered[2].inputFileName, "10.inp");

  assert.equal(discovered[3].name, "case-a");
  assert.equal(discovered[3].inputFileName, "case-a.in");
  assert.equal(discovered[3].outputPath, path.join(root, "case-a.ans"));

  const resolvedOne = resolveTestCaseFiles(root, "1");
  assert.ok(resolvedOne);
  assert.equal(resolvedOne.name, "1");
  assert.equal(resolvedOne.inputFileName, "1.inp");
  assert.equal(resolvedOne.outputPath, path.join(root, "1.out"));

  assert.equal(resolveTestCaseFiles(root, "incomplete"), null);
  assert.equal(resolveTestCaseFiles(root, "orphan"), null);
  assert.equal(resolveTestCaseFiles(root, "solution"), null);
});

test("flat test discovery for interactive problem allows input-only flat files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-flat-interactive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "1.inp"), "42");
  fs.writeFileSync(path.join(root, "2.in"), "99");

  assert.deepEqual(discoverTestCases(root, false), []);

  const interactiveTests = discoverTestCases(root, true);
  assert.equal(interactiveTests.length, 2);
  assert.equal(interactiveTests[0].name, "1");
  assert.equal(interactiveTests[0].outputPath, "");
  assert.equal(interactiveTests[1].name, "2");
  assert.equal(interactiveTests[1].outputPath, "");

  const resolvedInteractive = resolveTestCaseFiles(root, "1", true);
  assert.ok(resolvedInteractive);
  assert.equal(resolvedInteractive.name, "1");
  assert.equal(resolvedInteractive.outputPath, "");
});

test("testcase discovery prefers directory tests when Themis structure exists alongside root sample files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-themis-precedence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const dirName of ["Test01", "Test02"]) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "BAI1.INP"), "1");
    fs.writeFileSync(path.join(dir, "BAI1.OUT"), "2");
  }

  // Root sample file left over from problem setter testing
  fs.writeFileSync(path.join(root, "BAI1.INP"), "sample");
  fs.writeFileSync(path.join(root, "BAI1.OUT"), "sample");

  assert.deepEqual(listTestDirectories(root), ["Test01", "Test02"]);
  const discovered = discoverTestCases(root);
  assert.equal(discovered.length, 2);
  assert.equal(discovered[0].name, "Test01");
  assert.equal(discovered[1].name, "Test02");
});

test("createProblemDirectoryResolver resolves problem directory when directory itself is named after the problem", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-single-problem-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sumDir = path.join(root, "SUM");
  fs.mkdirSync(sumDir, { recursive: true });
  fs.writeFileSync(path.join(sumDir, "1.inp"), "1");
  fs.writeFileSync(path.join(sumDir, "1.out"), "2");

  const resolver = createProblemDirectoryResolver(sumDir);
  const resolved = resolver("sum");
  assert.ok(resolved);
  assert.equal(resolved.name, "SUM");
  assert.equal(resolved.path, sumDir);
});

test("Themis tests take precedence even when root samples outnumber them", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-layout-precedence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test1"));
  fs.writeFileSync(path.join(root, "test1", "official.inp"), "official");
  fs.writeFileSync(path.join(root, "test1", "official.out"), "answer");
  for (const stem of ["test1", "test2"]) {
    fs.writeFileSync(path.join(root, `${stem}.inp`), "sample");
    fs.writeFileSync(path.join(root, `${stem}.out`), "answer");
  }

  const discovered = discoverTestCases(root);
  assert.deepEqual(discovered.map(files => files.name), ["test1"]);
  assert.equal(discovered[0].inputPath, path.join(root, "test1", "official.inp"));
  assert.deepEqual(resolveTestCaseFiles(root, "test1"), discovered[0]);
  assert.equal(resolveTestCaseFiles(root, "test2"), null);
});

test("flat discovery resolves mixed extensions by matching the complete stem", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-mixed-flat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [input, output] of [
    ["test1.inp", "test1.out"],
    ["test2.in", "test2.ans"],
    ["CASE.3.INP", "case.3.ANS"],
    ["test4.in", "test4.out"],
    ["test5.inp", "test5.ans"],
  ]) {
    fs.writeFileSync(path.join(root, input), input);
    fs.writeFileSync(path.join(root, output), output);
  }
  fs.writeFileSync(path.join(root, "unmatched.inp"), "input");
  fs.writeFileSync(path.join(root, "other.out"), "output");
  fs.mkdirSync(path.join(root, "fake.inp"));
  fs.mkdirSync(path.join(root, "fake.out"));

  const discovered = discoverTestCases(root);
  assert.deepEqual(discovered.map(files => files.name), ["CASE.3", "test1", "test2", "test4", "test5"]);
  for (const files of discovered) {
    assert.deepEqual(resolveTestCaseFiles(root, files.name.toLowerCase()), files);
  }
});

test("problem resolver ignores files and cannot alias a missing or container directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-problem-resolver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "SUM"), "not a directory");
  const resolve = createProblemDirectoryResolver(root);
  assert.equal(resolve("SUM"), null);
  assert.equal(resolve(path.basename(root)), null);
  assert.throws(() => createProblemDirectoryResolver(path.join(root, "missing")), /ENOENT/);
});

test("flat aliases prefer inp and out and numeric name ties stay deterministic", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-flat-aliases-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const stem of ["1", "01", "10", "2"]) {
    for (const extension of ["in", "inp", "ans", "out"]) {
      fs.writeFileSync(path.join(root, `${stem}.${extension}`), extension);
    }
  }
  const discovered = discoverTestCases(root);
  assert.deepEqual(discovered.map(files => files.name), ["01", "1", "2", "10"]);
  for (const files of discovered) {
    assert.equal(files.inputFileName, `${files.name}.inp`);
    assert.equal(files.outputPath, path.join(root, `${files.name}.out`));
    assert.deepEqual(resolveTestCaseFiles(root, files.name), files);
  }
});

test("a direct flat problem takes precedence over its same-name auxiliary child", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-same-name-auxiliary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const problem = path.join(root, "SUM");
  fs.mkdirSync(path.join(problem, "SUM", "docs"), { recursive: true });
  fs.writeFileSync(path.join(problem, "1.inp"), "1");
  fs.writeFileSync(path.join(problem, "1.out"), "2");
  assert.deepEqual(createProblemDirectoryResolver(problem)("sum"), { name: "SUM", path: problem });
});

test("root samples cannot alias a real same-name Themis or interactive problem", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-real-child-problem-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
      fs.writeFileSync(path.join(problem, "Config.cfg"), JSON.stringify({ isInteractive: true }));
    }
    assert.deepEqual(createProblemDirectoryResolver(container)(name), { name, path: problem });
  }
});
