import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import type { BatchJudgeResult } from "../../types";
import {
  buildDiagnosticJson,
  buildScoreWorkbookBytes,
} from "./score-workbook";
import { createScoreWorkbookLabels } from "./score-workbook-client";
import {
  decodeScoreExportPayload,
  encodeScoreExportPayload,
} from "../../../shared/score-export-wire";

test("score export creates summary and detail worksheets", async () => {
  const result: BatchJudgeResult = {
    success: true,
    metadata: {
      startedAt: "2026-07-24T00:00:00.000Z",
      platform: "win32",
      arch: "x64",
      build: {
        appVersion: "1.2.5",
        gitCommit: "abc123",
        buildNumber: "42",
        builtAt: "2026-07-24T00:00:00.000Z",
      },
      executor: { mode: "windows-lpac-job", version: "1.2.5", ready: true },
      toolchains: {
        cpp: {
          source: "custom",
          version: "16.1.0",
          submissionReady: true,
          checkerReady: true,
          provenance: "certified-local",
          certificateId: `cert_${"a".repeat(64)}`,
          candidateFingerprint: "b".repeat(64),
          snapshotDigest: "c".repeat(64),
        },
        python: {
          source: "system",
          version: "3.12.8",
          submissionReady: false,
          checkerReady: false,
        },
      },
    },
    contestants: [{
      contestantName: "Alice",
      problems: [{
        problemName: "sum",
        language: "cpp",
        compileStatus: "OK",
        compileError: "",
        compileTime: 10,
        testCases: [{
          name: "01",
          status: "AC",
          executionTime: 12,
          score: 1,
          execution: {
            reason: "exited",
            exitCode: 0,
            securitySetupTimeUs: 10,
            wallTimeUs: 12_000,
            resultCollectionTimeUs: 20,
            stdoutBytes: 3,
            stderrBytes: 0,
          },
        }],
        summary: { total: 1, passed: 1, maxScore: 1, score: 1, status: "AC" }
      }]
    }]
  };
  const mockT = (key: string) => key;
  const workbookBytes = await buildScoreWorkbookBytes(
    result,
    ["Alice"],
    ["sum"],
    createScoreWorkbookLabels(mockT as any),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));
  assert.deepEqual(
    workbook.worksheets.map(sheet => sheet.name),
    ["export.scoreboardTitle", "export.detailsTitle", "Run Metadata"],
  );

  const summarySheet = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summarySheet.rowCount, 2);
  const summaryHeaders = summarySheet.getRow(1).values as string[];
  assert.deepEqual(summaryHeaders.slice(1), ["scoringLog.candidate", "sum", "scoreboard.total"]);
  assert.equal(summarySheet.getCell("A2").value, "Alice");
  assert.equal(summarySheet.getCell("B2").value, 1);
  assert.equal(workbook.getWorksheet("export.detailsTitle")?.getCell("C4").value, "01");
  assert.equal(workbook.getWorksheet("export.detailsTitle")?.getCell("G4").value, "AC");
  assert.equal(workbook.getWorksheet("export.detailsTitle")?.getCell("H4").value, "exited");
  assert.equal(workbook.getWorksheet("Run Metadata")?.getCell("B3").value, "1.2.5");

  const diagnostic = JSON.parse(buildDiagnosticJson(result, ["Alice"], ["sum"]));
  assert.equal(diagnostic.schemaVersion, 1);
  assert.equal(diagnostic.metadata.build.gitCommit, "abc123");
  assert.equal(diagnostic.metadata.toolchains.cpp.provenance, "certified-local");
  assert.equal(diagnostic.metadata.toolchains.cpp.snapshotDigest, "c".repeat(64));
  assert.equal(diagnostic.contestants[0].problems[0].testCases[0].execution.reason, "exited");

  const payload = encodeScoreExportPayload(workbookBytes, JSON.stringify(diagnostic));
  const decoded = decodeScoreExportPayload(payload);
  assert.deepEqual(decoded.workbook, workbookBytes);
  assert.deepEqual(JSON.parse(decoded.diagnosticJson), diagnostic);
});

test("score export leaves unjudged scoreboard cells blank", async () => {
  const mockT = (key: string) => key;
  const workbookBytes = await buildScoreWorkbookBytes(
    { success: true, contestants: [] },
    ["Alice"],
    ["sum"],
    createScoreWorkbookLabels(mockT as any),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));

  const summary = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summary.getCell("A2").value, "Alice");
  assert.equal(summary.getCell("B2").value, null);
  assert.equal(summary.getCell("C2").value, null);
});

test("score export supports a scoreboard with problems but no contestants", async () => {
  const mockT = (key: string) => key;
  const workbookBytes = await buildScoreWorkbookBytes(
    { success: true, contestants: [] },
    [],
    ["sum"],
    createScoreWorkbookLabels(mockT as any),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));

  const summary = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summary.rowCount, 1);
  assert.deepEqual(
    (summary.getRow(1).values as string[]).slice(1),
    ["scoringLog.candidate", "sum", "scoreboard.total"],
  );
});

test("score export wire format rejects invalid or truncated payloads", () => {
  assert.throws(
    () => decodeScoreExportPayload(new Uint8Array([1, 2, 3])),
    /empty or too large/,
  );
  const payload = encodeScoreExportPayload(new Uint8Array([1]), "{}");
  new DataView(payload.buffer).setUint32(8, payload.byteLength, true);
  assert.throws(() => decodeScoreExportPayload(payload), /truncated/);
});

test("score export matches contestant and problem names case-insensitively", async () => {
  const result: BatchJudgeResult = {
    success: true,
    contestants: [{
      contestantName: "alice",
      problems: [{
        problemName: "SUM",
        language: "cpp",
        compileStatus: "OK",
        compileError: "",
        compileTime: 10,
        testCases: [{
          name: "01",
          status: "AC",
          executionTime: 12,
          score: 10,
        }],
        summary: { total: 1, passed: 1, maxScore: 10, score: 10, status: "AC" },
      }],
    }],
  };
  const mockT = (key: string) => key;
  const workbookBytes = await buildScoreWorkbookBytes(
    result,
    ["Alice"],
    ["sum"],
    createScoreWorkbookLabels(mockT as any),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));

  const summarySheet = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summarySheet.getCell("A2").value, "Alice");
  assert.equal(summarySheet.getCell("B2").value, 10);
  assert.equal(summarySheet.getCell("C2").value, 10);
});

test("score export uses fallbackMetadata when judgeResult has no metadata", async () => {
  const fallbackMetadata = {
    startedAt: "2026-08-21T00:00:00.000Z",
    platform: "win32",
    arch: "x64",
    build: {
      appVersion: "1.3.7",
      gitCommit: "def456",
      buildNumber: "100",
      builtAt: "2026-08-21T00:00:00.000Z",
    },
    executor: { mode: "windows-lpac-job", version: "1.3.7", ready: true },
    toolchains: {
      cpp: { source: "managed", version: "13.2.0", submissionReady: true, checkerReady: true },
      python: { source: "system", version: "3.12.0", submissionReady: true, checkerReady: true },
    },
  };
  const mockT = (key: string) => key;
  const workbookBytes = await buildScoreWorkbookBytes(
    { success: true, contestants: [] },
    [],
    [],
    createScoreWorkbookLabels(mockT as any),
    fallbackMetadata,
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));

  const metadataSheet = workbook.getWorksheet("Run Metadata")!;
  assert.equal(metadataSheet.getCell("B2").value, "2026-08-21T00:00:00.000Z");
  assert.equal(metadataSheet.getCell("B3").value, "1.3.7");
  assert.equal(metadataSheet.getCell("B4").value, "def456");

  const summarySheet = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summarySheet.rowCount, 1); // Only header
});

test("score export auto-discovers problem and contestant names when selection is empty", async () => {
  const result: BatchJudgeResult = {
    success: true,
    contestants: [{
      contestantName: "C01_Nguyen Anh Duy",
      problems: [{
        problemName: "CAPNTO",
        language: "cpp",
        compileStatus: "OK",
        compileError: "",
        compileTime: 10,
        testCases: [{ name: "01", status: "AC", executionTime: 12, score: 9 }],
        summary: { total: 1, passed: 1, maxScore: 10, score: 9, status: "AC" },
      }],
    }],
  };
  const mockT = (key: string) => key;
  const workbookBytes = await buildScoreWorkbookBytes(
    result,
    [],
    [],
    createScoreWorkbookLabels(mockT as any),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));

  const summarySheet = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summarySheet.rowCount, 2);
  assert.equal(summarySheet.getCell("A2").value, "C01_Nguyen Anh Duy");
  assert.equal(summarySheet.getCell("B2").value, 9);
  assert.equal(summarySheet.getCell("C2").value, 9);
});

test("score export outputs sorted scoreboard and sorts detail sheet problems left-to-right", async () => {
  // Bob scored higher than Alice.
  // In judgeResult, Bob's problems are in reverse order [B_SORT, A_SUM]
  const result: BatchJudgeResult = {
    success: true,
    contestants: [
      {
        contestantName: "Alice",
        problems: [
          {
            problemName: "A_SUM",
            language: "cpp",
            compileStatus: "OK",
            testCases: [{ name: "01", status: "AC", executionTime: 10, score: 50 }],
            summary: { total: 1, passed: 1, maxScore: 100, score: 50, status: "PARTIAL" },
          },
          {
            problemName: "B_SORT",
            language: "cpp",
            compileStatus: "OK",
            testCases: [{ name: "01", status: "AC", executionTime: 10, score: 50 }],
            summary: { total: 1, passed: 1, maxScore: 100, score: 50, status: "PARTIAL" },
          },
        ],
      },
      {
        contestantName: "Bob",
        problems: [
          {
            problemName: "B_SORT",
            language: "cpp",
            compileStatus: "OK",
            testCases: [{ name: "01", status: "AC", executionTime: 10, score: 100 }],
            summary: { total: 1, passed: 1, maxScore: 100, score: 100, status: "AC" },
          },
          {
            problemName: "A_SUM",
            language: "cpp",
            compileStatus: "OK",
            testCases: [{ name: "01", status: "AC", executionTime: 10, score: 100 }],
            summary: { total: 1, passed: 1, maxScore: 100, score: 100, status: "AC" },
          },
        ],
      },
    ],
  };

  const mockT = (key: string) => key;
  // Passing Bob first (e.g. sorted high-to-low), and problems in order [A_SUM, B_SORT]
  const workbookBytes = await buildScoreWorkbookBytes(
    result,
    ["Bob", "Alice"],
    ["A_SUM", "B_SORT"],
    createScoreWorkbookLabels(mockT as any),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(workbookBytes));

  // Summary sheet: Bob is row 2, Alice is row 3
  const summarySheet = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summarySheet.getCell("A2").value, "Bob");
  assert.equal(summarySheet.getCell("D2").value, 200);
  assert.equal(summarySheet.getCell("A3").value, "Alice");
  assert.equal(summarySheet.getCell("D3").value, 100);

  // Detail sheet:
  // Bob comes first (top to bottom).
  // Bob's problems must appear in order: A_SUM first, then B_SORT (left to right),
  // even though Bob had B_SORT first in the judgeResult array!
  const detailSheet = workbook.getWorksheet("export.detailsTitle")!;
  const detailRows: Array<{ candidate: any; problem: any; score: any }> = [];
  detailSheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      detailRows.push({
        candidate: row.getCell(1).value,
        problem: row.getCell(2).value,
        score: row.getCell(4).value,
      });
    }
  });

  // Unique problem order for Bob must be [A_SUM, B_SORT]
  const bobProblemsInOrder = Array.from(
    new Set(
      detailRows
        .filter((r) => r.candidate === "Bob" && r.problem)
        .map((r) => r.problem),
    ),
  );
  assert.deepEqual(bobProblemsInOrder, ["A_SUM", "B_SORT"]);

  // Unique problem order for Alice must be [A_SUM, B_SORT]
  const aliceProblemsInOrder = Array.from(
    new Set(
      detailRows
        .filter((r) => r.candidate === "Alice" && r.problem)
        .map((r) => r.problem),
    ),
  );
  assert.deepEqual(aliceProblemsInOrder, ["A_SUM", "B_SORT"]);
});
