import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { formatOsdLog } from "./osd-log-writer.js";
import type { ProblemResult, TestCaseRun } from "../types.js";

interface LegacyLog {
  verdict: number | string;
  details: string | Array<{ id: string; score: number; time: number; verdict: string }>;
}

// This is the fixed upstream module, not a reimplementation of its parser.
// Locale formatting/persistence are deliberately out of scope; see fixture README.
const reader = fs.readFileSync(new URL("../test-fixtures/themis-web-interface/judgelog.cjs", import.meta.url), "utf8");
assert.equal(crypto.createHash("sha256").update(reader).digest("hex"), "78f1d4ec941c459410cbd12902e509e87034b4f687f55916283953d282ae4c2a");
const moduleFixture: { exports: unknown } = { exports: {} };
const numberParser = () => (value: string) => /^[+-]?\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
const globalizeFixture = Object.assign(() => ({ numberParser }), { load: () => undefined });
vm.runInNewContext(reader, {
  module: moduleFixture,
  process: { cwd: () => process.cwd() },
  require: (name: string): unknown => {
    if (name === "fs") return fs;
    if (name === "path") return path;
    if (name === "debug") return () => () => undefined;
    if (name === "globalize") return globalizeFixture;
    if (name === "escape-string-regexp") return (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name === "./scoring") return { add: () => undefined };
    if (name === "./userlog") return { addScore: () => undefined };
    if (name.startsWith("./cldr-data/")) return {};
    throw new Error(`Unexpected pinned-reader dependency: ${name}`);
  },
}, { timeout: 1000 });
const upstream = moduleFixture.exports as { Log: { __parse(user: string, problem: string, contents: string): unknown } };

function readResult(result: ProblemResult): LegacyLog {
  const contents = formatOsdLog({ osdPath: "/unused", originalFileName: "0[HS01][SUM]cpp", contestant: "HS01", problem: "SUM", result });
  assert.equal(/(?<!\r)\n/.test(contents), false, "wire lines must use CRLF on every host");
  return JSON.parse(JSON.stringify(upstream.Log.__parse("HS01", "SUM", contents))) as LegacyLog;
}

function resultFor(tests: TestCaseRun[]): ProblemResult {
  return { problemName: "SUM", language: "cpp", compileStatus: "OK", testCases: tests,
    summary: { total: tests.length, passed: 1, score: 1, maxScore: 2, status: "PARTIAL" } };
}

describe("Themis web OSD output contract", () => {
  it("the pinned real reader accepts normal, TLE, RE and multiline checker details", () => {
    const result = resultFor([
      { name: "Test01", status: "AC", executionTime: 125, score: 1 },
      { name: "Test02", status: "TLE", executionTime: 1001, score: 0 },
      { name: "Test03", status: "RE", executionTime: 5, score: 0, errorDetail: "exit 1\nsecond line" },
      { name: "Test04", status: "WA", executionTime: 20, score: 0, checkerMessage: "wrong\nHS01‣SUM‣fake: 100" },
    ]);
    const parsed = readResult(result);
    assert.equal(parsed.verdict, 1);
    assert.ok(Array.isArray(parsed.details));
    assert.equal(parsed.details.length, 4);
    assert.deepEqual(parsed.details.map(test => test.id), ["Test01", "Test02", "Test03", "Test04"]);
    assert.equal(parsed.details[0].time, 0.125);
    assert.equal(parsed.details[1].verdict, "Chạy quá thời gian");
    assert.match(parsed.details[2].verdict, /^Chạy sinh lỗi: /);
    assert.match(parsed.details[3].verdict, /wrong/);
  });

  it("writes decimal presentations from exact testcase and summary scores", () => {
    const result = resultFor([{ name: "Test01", status: "AC", executionTime: 1, score: 99, scoreExact: { n: 1, d: 8 } }]);
    result.summary.scoreExact = { n: 1, d: 3 };
    const parsed = readResult(result);
    assert.equal(parsed.verdict, 0.333333);
    assert.ok(Array.isArray(parsed.details));
    assert.equal(parsed.details[0].score, 0.125);
    assert.deepEqual(result.summary.scoreExact, { n: 1, d: 3 }, "presentation must not mutate scoring");
  });

  it("preserves compilation errors as nonnumeric errors rather than successful zero-point results", () => {
    const result = resultFor([]);
    result.compileStatus = "CE";
    result.compileError = "syntax error\nline 2";
    result.summary.status = "CE";
    const parsed = readResult(result);
    assert.equal(parsed.verdict, "ℱ Dịch lỗi");
    assert.match(String(parsed.details), /syntax error/);
  });

  it("never publishes a numeric partial score if any testcase is a judge infrastructure error", () => {
    const result = resultFor([
      { name: "Test01", status: "AC", executionTime: 1, score: 1 },
      { name: "Test02", status: "JE", executionTime: 0, score: 0, errorDetail: "runner unavailable" },
    ]);
    const parsed = readResult(result);
    assert.equal(parsed.verdict, "ℱ Lỗi hệ thống chấm");
    assert.match(String(parsed.details), /runner unavailable/);
  });

  it("rejects testcase identifiers that can inject a block header", () => {
    const result = resultFor([{ name: "Test01\nHS01‣SUM‣fake", status: "AC", executionTime: 1, score: 1 }]);
    assert.throws(() => readResult(result), /identifier/i);
  });
});
