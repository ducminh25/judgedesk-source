import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSubmission, listContestants } from "./submission-discovery";
import { createProblemDirectoryResolver, listTestDirectories, resolveTestCaseFiles } from "./testcase-discovery";

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
