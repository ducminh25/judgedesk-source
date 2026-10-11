import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { formatOsdLog, writeOsdLog } from "./osd-log-writer.js";
import type { ProblemResult } from "../types.js";

describe("osd-log-writer", () => {
  it("formats log for rejected submission", () => {
    const log = formatOsdLog({
      osdPath: "/tmp",
      originalFileName: "bad_file.cpp",
      errorReason: "INVALID_FILENAME_FORMAT",
      timestamp: new Date("2026-08-21T10:00:00Z"),
    });
    assert.match(log, /TRẠNG THÁI: TỪ CHỐI BÀI NỘP/);
    assert.match(log, /INVALID_FILENAME_FORMAT/);
  });

  it("formats log for completed submission with testcases", () => {
    const mockResult: ProblemResult = {
      problemName: "SUM",
      language: "cpp",
      compileStatus: "OK",
      compileTime: 120,
      testCases: [
        {
          name: "Test01",
          status: "AC",
          executionTime: 15,
          peakMemory: 2048,
          score: 1.0,
        },
        {
          name: "Test02",
          status: "WA",
          executionTime: 25,
          peakMemory: 2100,
          score: 0.0,
          checkerMessage: "Wrong answer on line 1",
        },
      ],
      summary: {
        total: 2,
        passed: 1,
        score: 1.0,
        maxScore: 2.0,
        status: "PARTIAL",
      },
    };

    const log = formatOsdLog({
      osdPath: "/tmp",
      originalFileName: "[HS01][SUM].cpp",
      contestant: "HS01",
      problem: "SUM",
      language: "cpp",
      result: mockResult,
      timestamp: new Date("2026-08-21T10:00:00Z"),
    });

    // The external contract now targets Themis readers, not the old decorative report.
    assert.match(log, /^HS01‣SUM: 1\.000000\r\n/);
    assert.match(log, /SUM\.cpp\r\nDịch thành công\r\n\r\n/);
    assert.match(log, /HS01‣SUM‣Test01: 1\.000000/);
    assert.match(log, /HS01‣SUM‣Test02: 0\.000000/);
    assert.match(log, /Kết quả khớp đáp án!/);
    assert.match(log, /Wrong answer on line 1/);
  });

  it("writes log file atomically in the lowercase logs subfolder", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_log_test_"));
    try {
      const writtenPath = writeOsdLog({
        osdPath: tempDir,
        originalFileName: "[Mon][GCD].pas",
        contestant: "Mon",
        problem: "GCD",
        language: "pascal",
        errorReason: "COMPILER_NOT_FOUND",
      });

      assert.equal(fs.existsSync(writtenPath), true);
      assert.equal(writtenPath, path.join(tempDir, "logs", "[Mon][GCD].pas.log"));
      const content = fs.readFileSync(writtenPath, "utf8");
      assert.match(content, /COMPILER_NOT_FOUND/);
      assert.deepEqual(fs.readdirSync(path.dirname(writtenPath)), ["[Mon][GCD].pas.log"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses log directories redirected outside the selected OSD root", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk_osd_log_link_"));
    const root = path.join(tempDir, "osd");
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "logs"), "junction");
    try {
      assert.throws(() => writeOsdLog({ osdPath: root, originalFileName: "0[HS01][SUM]cpp", errorReason: "test" }), /link|directory/i);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
