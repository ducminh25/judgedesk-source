import type ExcelJS from "exceljs";
import type { BatchJudgeResult, ContestantResult } from "../../types";
import { describeTestResult } from "../judging/verdict";
import type { TFunction } from "i18next";

export async function buildScoreWorkbookBase64(
  judgeResult: BatchJudgeResult,
  contestantNames: string[],
  problemNames: string[],
  t: TFunction
): Promise<string> {
  const contestants = contestantNames.map(
    name => judgeResult.contestants.find(item => item.contestantName === name) || emptyContestant(name)
  );
  const ExcelJSRuntime = (await import("exceljs")).default;
  const workbook = new ExcelJSRuntime.Workbook();
  addSheet(workbook, t("export.scoreboardTitle"), [t("scoringLog.candidate"), ...problemNames, t("scoreboard.total")], buildSummaryRows(contestants, problemNames, t));
  addSheet(
    workbook,
    t("export.detailsTitle"),
    [
      t("scoringLog.candidate"),
      t("scoringLog.problem"),
      t("scoringLog.test"),
      t("scoringLog.score"),
      t("scoringLog.time"),
      t("scoringLog.results"),
      "Verdict",
      "Executor reason",
      "Exit code",
      "Signal/status",
      "Error detail",
      "Checker message",
      "Security setup (us)",
      "Wall time (us)",
      "User CPU (us)",
      "Kernel CPU (us)",
      "Peak memory (bytes)",
      "Configured memory limit (bytes)",
      "Effective memory limit (bytes)",
      "Stdout (bytes)",
      "Stderr (bytes)",
      "Created files",
      "Executor diagnostic",
    ],
    buildDetailRows(contestants, problemNames, t),
  );
  addRunMetadataSheet(workbook, judgeResult);
  const buffer = await workbook.xlsx.writeBuffer();
  return toBase64(buffer);
}

export function buildDiagnosticJson(
  judgeResult: BatchJudgeResult,
  contestantNames: string[],
  problemNames: string[],
): string {
  const contestants = contestantNames.map(
    (name) => judgeResult.contestants.find((item) => item.contestantName === name) || emptyContestant(name),
  );
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    metadata: judgeResult.metadata,
    selection: {
      contestants: contestantNames,
      problems: problemNames,
    },
    contestants: contestants.map((contestant) => ({
      ...contestant,
      problems: contestant.problems.filter((problem) =>
        problemNames.some((name) => name.toLowerCase() === problem.problemName.toLowerCase()),
      ),
    })),
  }, null, 2);
}

function addSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Array<Record<string, string | number>>
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = headers.map(header => ({ header, key: header, width: 10 }));
  sheet.addRows(rows);
  for (const column of sheet.columns) {
    let maxLength = 10;
    column.eachCell({ includeEmpty: true }, cell => {
      if (cell.value == null) return;
      maxLength = Math.max(maxLength, ...String(cell.value).split("\n").map(line => line.length));
    });
    column.width = maxLength + 3;
  }
}

function addRunMetadataSheet(
  workbook: ExcelJS.Workbook,
  judgeResult: BatchJudgeResult,
): void {
  const metadata = judgeResult.metadata;
  const rows: Array<Record<string, string | number>> = metadata
    ? [
        { Field: "Run started at", Value: metadata.startedAt },
        { Field: "App version", Value: metadata.build.appVersion },
        { Field: "Git commit", Value: metadata.build.gitCommit },
        { Field: "Build number", Value: metadata.build.buildNumber },
        { Field: "Build timestamp", Value: metadata.build.builtAt },
        { Field: "Platform", Value: metadata.platform },
        { Field: "Architecture", Value: metadata.arch },
        { Field: "Executor mode", Value: metadata.executor.mode },
        { Field: "Executor version", Value: metadata.executor.version },
        { Field: "Executor ready", Value: String(metadata.executor.ready) },
        { Field: "C++ source", Value: metadata.toolchains.cpp.source },
        { Field: "C++ version", Value: metadata.toolchains.cpp.version },
        { Field: "C++ submission ready", Value: String(metadata.toolchains.cpp.submissionReady) },
        { Field: "Python source", Value: metadata.toolchains.python.source },
        { Field: "Python version", Value: metadata.toolchains.python.version },
        { Field: "Python submission ready", Value: String(metadata.toolchains.python.submissionReady) },
        { Field: "Python checker ready", Value: String(metadata.toolchains.python.checkerReady) },
      ]
    : [{ Field: "Metadata", Value: "Unavailable (legacy or incomplete run)" }];
  addSheet(workbook, "Run Metadata", ["Field", "Value"], rows);
}

function buildSummaryRows(contestants: ContestantResult[], problemNames: string[], t: TFunction) {
  return contestants.map(contestant => {
    const row: Record<string, string | number> = { [t("scoringLog.candidate")]: contestant.contestantName };
    let totalScore = 0;
    for (const problemName of problemNames) {
      const problem = findProblem(contestant, problemName);
      if (!problem || (problem.compileStatus === "SKIPPED" && problem.compileError === "not_found")) {
        row[problemName] = t("export.notFound");
      } else if (problem.compileStatus !== "OK") {
        row[problemName] = t("export.compilationError");
      } else {
        row[problemName] = problem.summary.score;
        totalScore += problem.summary.score;
      }
    }
    row[t("scoreboard.total")] = roundScore(totalScore);
    return row;
  });
}

function buildDetailRows(contestants: ContestantResult[], problemNames: string[], t: TFunction) {
  const rows: Array<Record<string, string | number>> = [];
  for (const contestant of contestants) {
    const problems = contestant.problems.filter(problem =>
      problemNames.some(name => name.toLowerCase() === problem.problemName.toLowerCase())
    );
    rows.push({
      [t("scoringLog.candidate")]: contestant.contestantName,
      [t("scoringLog.problem")]: "",
      [t("scoringLog.test")]: "",
      [t("scoringLog.score")]: roundScore(problems.reduce((total, problem) => total + problem.summary.score, 0)),
      [t("scoringLog.time")]: "",
      [t("scoringLog.results")]: ""
    });
    for (const problem of problems) {
      rows.push({
        [t("scoringLog.candidate")]: contestant.contestantName,
        [t("scoringLog.problem")]: problem.problemName,
        [t("scoringLog.test")]: "",
        [t("scoringLog.score")]: problem.summary.score,
        [t("scoringLog.time")]: "",
        [t("scoringLog.results")]:
          problem.compileStatus === "SKIPPED" && problem.compileError === "not_found"
            ? t("export.notFound")
            : problem.compileStatus === "OK"
              ? t("export.compilationSuccess")
              : t("export.compilationError")
      });
      for (const test of problem.testCases) {
        const execution = test.execution;
        rows.push({
          [t("scoringLog.candidate")]: contestant.contestantName,
          [t("scoringLog.problem")]: problem.problemName,
          [t("scoringLog.test")]: test.name,
          [t("scoringLog.score")]: test.score,
          [t("scoringLog.time")]: `${(test.executionTime / 1000).toFixed(3)} ${t("scoringLog.seconds")}`,
          [t("scoringLog.results")]: describeTestResult(test),
          Verdict: test.status,
          "Executor reason": execution?.reason || "",
          "Exit code": execution?.exitCode ?? "",
          "Signal/status": execution?.signalOrStatus || "",
          "Error detail": test.errorDetail || "",
          "Checker message": test.checkerMessage || "",
          "Security setup (us)": execution?.securitySetupTimeUs ?? "",
          "Wall time (us)": execution?.wallTimeUs ?? "",
          "User CPU (us)": execution?.userCpuTimeUs ?? "",
          "Kernel CPU (us)": execution?.kernelCpuTimeUs ?? "",
          "Peak memory (bytes)": execution?.peakMemoryBytes ?? "",
          "Configured memory limit (bytes)": execution?.configuredMemoryLimitBytes ?? "",
          "Effective memory limit (bytes)": execution?.effectiveMemoryLimitBytes ?? "",
          "Stdout (bytes)": execution?.stdoutBytes ?? "",
          "Stderr (bytes)": execution?.stderrBytes ?? "",
          "Created files": execution?.createdFiles ?? "",
          "Executor diagnostic": execution?.diagnostic || "",
        });
      }
    }
  }
  return rows;
}

function findProblem(contestant: ContestantResult, problemName: string) {
  return contestant.problems.find(problem => problem.problemName.toLowerCase() === problemName.toLowerCase());
}

function emptyContestant(contestantName: string): ContestantResult {
  return { contestantName, problems: [] };
}

function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
