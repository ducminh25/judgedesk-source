import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  validateProblemTestInputs,
  validateTestInputFile,
} from "./test-wellformed.js";

async function createFixture(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "judgedesk-wellformed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function validateContent(t: TestContext, content: string) {
  const directory = await createFixture(t);
  const inputPath = path.join(directory, "sample.inp");
  await fs.writeFile(inputPath, content, "utf8");
  const original = await fs.readFile(inputPath);
  const issues = await validateTestInputFile(inputPath);
  assert.deepEqual(await fs.readFile(inputPath), original, "validation must preserve input bytes");
  return issues;
}

test("well-formed inputs accept LF and CRLF without treating their final EOLN as an empty line", async (t) => {
  for (const content of ["1\n", "1 2\n3 4\n", "1\r\n", "1 2\r\n3 4\r\n"]) {
    assert.deepEqual(await validateContent(t, content), [], JSON.stringify(content));
  }
});

test("well-formed inputs accept Unicode text and internal empty lines", async (t) => {
  assert.deepEqual(await validateContent(t, "Tiếng Việt 東京 😀\n\n3 4\n"), []);
  assert.deepEqual(await validateContent(t, "đầu\r\n\r\ncuối\r\n"), []);
  assert.deepEqual(await validateContent(t, "\u00a0value\u00a0\n"), []);
});

test("an empty input reports the empty issue", async (t) => {
  assert.deepEqual(await validateContent(t, ""), [{ code: "empty", line: 1, column: 1 }]);
});

test("a final line without EOLN reports its EOF position", async (t) => {
  assert.deepEqual(await validateContent(t, "first\nlast"), [
    { code: "missing_eol", line: 2, column: 5 },
  ]);
});

for (const [label, character] of [
  ["bare CR", "\r"],
  ["tab", "\t"],
  ["NUL", "\0"],
  ["vertical tab", "\u000b"],
] as const) {
  test(`${label} in input reports a control character without normalizing it`, async (t) => {
    const issues = await validateContent(t, `ab${character}cd\n`);
    assert.ok(issues.some((issue) => issue.code === "control_character"
      && issue.line === 1 && issue.column === 3));
  });
}

test("byte values 32 and above are permitted by the stated Polygon rule", async (t) => {
  assert.deepEqual(await validateContent(t, "ab\u007fcd\n"), []);
  const directory = await createFixture(t);
  const inputPath = path.join(directory, "raw.inp");
  await fs.writeFile(inputPath, Buffer.from([0xff, 0xfe, 10]));
  assert.deepEqual(await validateTestInputFile(inputPath), []);
});

test("a terminal bare CR is rejected rather than accepted as EOLN", async (t) => {
  const issues = await validateContent(t, "value\r");
  assert.ok(issues.some((issue) => issue.code === "control_character"
    && issue.line === 1 && issue.column === 6));
  assert.ok(issues.some((issue) => issue.code === "missing_eol"));
});

test("leading and trailing ASCII spaces identify the affected line edges", async (t) => {
  assert.deepEqual(await validateContent(t, " value\n"), [
    { code: "edge_space", line: 1, column: 1 },
  ]);
  assert.deepEqual(await validateContent(t, "value \r\n"), [
    { code: "edge_space", line: 1, column: 6 },
  ]);
});

test("two consecutive ASCII spaces report the second space in the run", async (t) => {
  assert.deepEqual(await validateContent(t, "a  b\n"), [
    { code: "consecutive_spaces", line: 1, column: 3 },
  ]);
});

test("a longer run of ASCII spaces is rejected", async (t) => {
  const issues = await validateContent(t, "a    b\n");
  assert.ok(issues.some((issue) => issue.code === "consecutive_spaces"));
});

test("leading and trailing empty lines are rejected while internal empty lines remain valid", async (t) => {
  assert.deepEqual(await validateContent(t, "\nvalue\n"), [
    { code: "edge_empty_line", line: 1, column: 1 },
  ]);
  assert.deepEqual(await validateContent(t, "value\r\n\r\n"), [
    { code: "edge_empty_line", line: 2, column: 1 },
  ]);
});

test("an input consisting only of EOLN is an edge empty line", async (t) => {
  const issues = await validateContent(t, "\n");
  assert.ok(issues.some((issue) => issue.code === "edge_empty_line"
    && issue.line === 1 && issue.column === 1));
});

test("validation examines bytes beyond the 35-byte content preview", async (t) => {
  assert.deepEqual(await validateContent(t, `${"a".repeat(80)}  b\n`), [
    { code: "consecutive_spaces", line: 1, column: 82 },
  ]);
});

test("consecutive spaces spanning a 64 KiB boundary are rejected", async (t) => {
  assert.deepEqual(await validateContent(t, `${"a".repeat(64 * 1024 - 1)}  b\n`), [
    { code: "consecutive_spaces", line: 1, column: 64 * 1024 + 1 },
  ]);
});

test("CRLF spanning a 64 KiB boundary is accepted as a single EOLN", async (t) => {
  assert.deepEqual(await validateContent(t, `${"a".repeat(64 * 1024 - 1)}\r\nb\n`), []);
});

test("problem validation reports input issues with testcase and filename and preserves expected outputs", async (t) => {
  const directory = await createFixture(t);
  const first = path.join(directory, "01");
  const second = path.join(directory, "02");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, "SUM.inp"), "1 2\n");
  await fs.writeFile(path.join(second, "SUM.inp"), "a  b\n");
  const output = Buffer.from(" \t\0 invalid expected output ");
  const outputPath = path.join(first, "SUM.out");
  await fs.writeFile(outputPath, output);
  await fs.writeFile(path.join(second, "SUM.out"), "also no EOLN");

  assert.deepEqual(await validateProblemTestInputs(directory), {
    tests: 2,
    issues: [{ code: "consecutive_spaces", line: 1, column: 3, testName: "02", fileName: "SUM.inp" }],
  });
  assert.deepEqual(await fs.readFile(outputPath), output);
});

test("problem validation uses only discovered judgeable flat tests", async (t) => {
  const directory = await createFixture(t);
  await fs.writeFile(path.join(directory, "01.in"), "1\r\n");
  await fs.writeFile(path.join(directory, "01.ans"), " invalid answer ");
  await fs.writeFile(path.join(directory, "02.inp"), "2\n");
  await fs.writeFile(path.join(directory, "02.out"), "\0");
  await fs.writeFile(path.join(directory, "orphan.inp"), "\t");
  await fs.writeFile(path.join(directory, "README.txt"), "\0");

  assert.deepEqual(await validateProblemTestInputs(directory), { tests: 2, issues: [] });
});

test("problem validation preserves directory-test precedence over root sample pairs", async (t) => {
  const directory = await createFixture(t);
  const testcase = path.join(directory, "test01");
  await fs.mkdir(testcase);
  await fs.writeFile(path.join(testcase, "SUM.inp"), "1\n");
  await fs.writeFile(path.join(testcase, "SUM.out"), "answer");
  await fs.writeFile(path.join(directory, "sample.inp"), " \t bad sample");
  await fs.writeFile(path.join(directory, "sample.out"), "answer");

  assert.deepEqual(await validateProblemTestInputs(directory), { tests: 1, issues: [] });
});

test("interactive validation includes inputs without expected-output files", async (t) => {
  const directory = await createFixture(t);
  await fs.writeFile(path.join(directory, "01.inp"), "1\n");
  await fs.writeFile(path.join(directory, "02.inp"), "a  b\n");

  assert.deepEqual(await validateProblemTestInputs(directory, true), {
    tests: 2,
    issues: [{ code: "consecutive_spaces", line: 1, column: 3, testName: "02", fileName: "02.inp" }],
  });
  assert.deepEqual(await validateProblemTestInputs(directory, false), { tests: 0, issues: [] });
});

test("a missing input rejects validation rather than producing an input issue", async (t) => {
  const directory = await createFixture(t);
  await assert.rejects(validateTestInputFile(path.join(directory, "missing.inp")), { code: "ENOENT" });
});

test("an input that cannot be read as a file rejects validation", async (t) => {
  const directory = await createFixture(t);
  const inputPath = path.join(directory, "input.inp");
  await fs.mkdir(inputPath);
  await assert.rejects(validateTestInputFile(inputPath));
});
