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

    assert.match(log, /Thí sinh\s+:\s+HS01/);
    assert.match(log, /Bài thi\s+:\s+SUM/);
    assert.match(log, /KẾT QUẢ BIÊN DỊCH:\s+- Trạng thái: THÀNH CÔNG/);
    assert.match(log, /Test 01 \(Test01\): \[ĐÚNG\]/);
    assert.match(log, /Test 02 \(Test02\): \[SAI\]/);
    assert.match(log, /TỔNG KẾT: 1\.00 \/ 2\.00 điểm/);
  });

  it("writes log file to disk in Logs subfolder", () => {
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
      assert.equal(writtenPath, path.join(tempDir, "Logs", "[Mon][GCD].pas.log"));
      const content = fs.readFileSync(writtenPath, "utf8");
      assert.match(content, /COMPILER_NOT_FOUND/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
