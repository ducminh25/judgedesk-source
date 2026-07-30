import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import type { BatchJudgeResult } from "../../types";
import { buildDiagnosticJson, buildScoreWorkbookBase64 } from "./score-workbook";

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
  const base64 = await buildScoreWorkbookBase64(result, ["Alice"], ["sum"], mockT as any);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, "base64"));
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
});
