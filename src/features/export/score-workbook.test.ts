import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import type { BatchJudgeResult } from "../../types";
import { buildScoreWorkbookBase64 } from "./score-workbook";

test("score export creates summary and detail worksheets", async () => {
  const result: BatchJudgeResult = {
    success: true,
    contestants: [{
      contestantName: "Alice",
      problems: [{
        problemName: "sum",
        language: "cpp",
        compileStatus: "OK",
        compileError: "",
        compileTime: 10,
        testCases: [{ name: "01", status: "AC", executionTime: 12, score: 1 }],
        summary: { total: 1, passed: 1, maxScore: 1, score: 1, status: "AC" }
      }]
    }]
  };
  const mockT = (key: string) => key;
  const base64 = await buildScoreWorkbookBase64(result, ["Alice"], ["sum"], mockT as any);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, "base64"));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["export.scoreboardTitle", "export.detailsTitle"]);

  const summarySheet = workbook.getWorksheet("export.scoreboardTitle")!;
  assert.equal(summarySheet.rowCount, 2);
  const summaryHeaders = summarySheet.getRow(1).values as string[];
  assert.deepEqual(summaryHeaders.slice(1), ["scoringLog.candidate", "sum", "scoreboard.total"]);
  assert.equal(summarySheet.getCell("A2").value, "Alice");
  assert.equal(summarySheet.getCell("B2").value, 1);
  assert.equal(workbook.getWorksheet("export.detailsTitle")?.getCell("C4").value, "01");
});
