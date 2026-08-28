import type ExcelJS from "exceljs";
import type { BatchJudgeResult, ContestantResult, RunMetadata } from "../../types";
import { describeTestResult } from "../judging/verdict";

export interface ScoreWorkbookLabels {
  scoreboardTitle: string;
  detailsTitle: string;
  candidate: string;
  problem: string;
  test: string;
  score: string;
  time: string;
  results: string;
  total: string;
  seconds: string;
  notFound: string;
  compilationError: string;
  compilationSuccess: string;
}

export interface ScoreExportBuildRequest {
  judgeResult: BatchJudgeResult;
  contestantNames: string[];
  problemNames: string[];
  labels: ScoreWorkbookLabels;
  fallbackMetadata?: RunMetadata;
}

type WorkbookCellValue = string | number | null;

import { APP_VERSION } from "../../version";

export async function buildScoreWorkbookBytes(
  judgeResult: BatchJudgeResult,
  contestantNames: string[],
  problemNames: string[],
  labels: ScoreWorkbookLabels,
  fallbackMetadata?: RunMetadata,
): Promise<Uint8Array> {
  const effectiveProblemNames = problemNames.length > 0
    ? problemNames
    : Array.from(new Set(judgeResult.contestants.flatMap((c) => c.problems.map((p) => p.problemName))));

  const effectiveContestantNames = contestantNames.length > 0
    ? contestantNames
    : judgeResult.contestants.map((c) => c.contestantName);

  const contestants = effectiveContestantNames.map((name) => {
    const match = judgeResult.contestants.find(
      (item) => item.contestantName.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    return match ? { ...match, contestantName: name } : emptyContestant(name);
  });
  const ExcelJSRuntime = (await import("exceljs")).default;
  const workbook = new ExcelJSRuntime.Workbook();
  addSheet(workbook, labels.scoreboardTitle, [labels.candidate, ...effectiveProblemNames, labels.total], buildSummaryRows(contestants, effectiveProblemNames, labels));
  addSheet(
    workbook,
    labels.detailsTitle,
    [
      labels.candidate,
      labels.problem,
      labels.test,
      labels.score,
      labels.time,
      labels.results,
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
    buildDetailRows(contestants, effectiveProblemNames, labels),
  );
  addRunMetadataSheet(workbook, judgeResult, fallbackMetadata);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export function buildDiagnosticJson(
  judgeResult: BatchJudgeResult,
  contestantNames: string[],
  problemNames: string[],
  fallbackMetadata?: RunMetadata,
): string {
  const effectiveProblemNames = problemNames.length > 0
    ? problemNames
    : Array.from(new Set(judgeResult.contestants.flatMap((c) => c.problems.map((p) => p.problemName))));

  const effectiveContestantNames = contestantNames.length > 0
    ? contestantNames
    : judgeResult.contestants.map((c) => c.contestantName);

  const contestants = effectiveContestantNames.map((name) => {
    const match = judgeResult.contestants.find(
      (item) => item.contestantName.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    return match ? { ...match, contestantName: name } : emptyContestant(name);
  });
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    metadata: judgeResult.metadata ?? fallbackMetadata,
    selection: {
      contestants: effectiveContestantNames,
      problems: effectiveProblemNames,
    },
    contestants: contestants.map((contestant) => ({
      ...contestant,
      problems: contestant.problems.filter((problem) =>
        effectiveProblemNames.some((name) => name.trim().toLowerCase() === problem.problemName.trim().toLowerCase()),
      ),
    })),
  }, null, 2);
}

function addSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Array<Record<string, WorkbookCellValue>>
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
  fallbackMetadata?: RunMetadata,
): void {
  const metadata = judgeResult.metadata ?? fallbackMetadata;
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
        { Field: "C++ checker ready", Value: String(metadata.toolchains.cpp.checkerReady ?? false) },
        { Field: "C++ provenance", Value: metadata.toolchains.cpp.provenance || "" },
        { Field: "C++ certificate ID", Value: metadata.toolchains.cpp.certificateId || "" },
        { Field: "C++ candidate fingerprint", Value: metadata.toolchains.cpp.candidateFingerprint || "" },
        { Field: "C++ snapshot digest", Value: metadata.toolchains.cpp.snapshotDigest || "" },
        { Field: "Python source", Value: metadata.toolchains.python.source },
        { Field: "Python version", Value: metadata.toolchains.python.version },
        { Field: "Python submission ready", Value: String(metadata.toolchains.python.submissionReady) },
        { Field: "Python checker ready", Value: String(metadata.toolchains.python.checkerReady) },
      ]
    : [
        { Field: "Exported at", Value: new Date().toISOString() },
        { Field: "App version", Value: APP_VERSION },
        { Field: "Status", Value: judgeResult.contestants.length > 0 ? "Contest results available" : "No judging runs" },
        { Field: "Total contestants in run", Value: judgeResult.contestants.length },
      ];
  addSheet(workbook, "Run Metadata", ["Field", "Value"], rows);
}

function buildSummaryRows(
  contestants: ContestantResult[],
  problemNames: string[],
  labels: ScoreWorkbookLabels,
) {
  return contestants.map(contestant => {
    const row: Record<string, WorkbookCellValue> = { [labels.candidate]: contestant.contestantName };
    let totalScore = 0;
    let hasResult = false;
    for (const problemName of problemNames) {
      const problem = findProblem(contestant, problemName);
      if (!problem) {
        row[problemName] = null;
      } else if (problem.compileStatus === "SKIPPED" && problem.compileError === "not_found") {
        hasResult = true;
        row[problemName] = labels.notFound;
      } else if (problem.compileStatus !== "OK") {
        hasResult = true;
        row[problemName] = labels.compilationError;
      } else {
        hasResult = true;
        row[problemName] = problem.summary.score;
        totalScore += problem.summary.score;
      }
    }
    row[labels.total] = hasResult ? roundScore(totalScore) : null;
    return row;
  });
}

function buildDetailRows(
  contestants: ContestantResult[],
  problemNames: string[],
  labels: ScoreWorkbookLabels,
) {
  const rows: Array<Record<string, WorkbookCellValue>> = [];
  const problemOrder = new Map(
    problemNames.map((name, index) => [name.trim().toLowerCase(), index]),
  );

  for (const contestant of contestants) {
    const problems = contestant.problems
      .filter((problem) =>
        problemOrder.has(problem.problemName.trim().toLowerCase()),
      )
      .sort((a, b) => {
        const orderA = problemOrder.get(a.problemName.trim().toLowerCase()) ?? 0;
        const orderB = problemOrder.get(b.problemName.trim().toLowerCase()) ?? 0;
        return orderA - orderB;
      });
    rows.push({
      [labels.candidate]: contestant.contestantName,
      [labels.problem]: "",
      [labels.test]: "",
      [labels.score]: problems.length > 0
        ? roundScore(problems.reduce((total, problem) => total + problem.summary.score, 0))
        : null,
      [labels.time]: "",
      [labels.results]: ""
    });
    for (const problem of problems) {
      rows.push({
        [labels.candidate]: contestant.contestantName,
        [labels.problem]: problem.problemName,
        [labels.test]: "",
        [labels.score]: problem.summary.score,
        [labels.time]: "",
        [labels.results]:
          problem.compileStatus === "SKIPPED" && problem.compileError === "not_found"
            ? labels.notFound
            : problem.compileStatus === "OK"
              ? labels.compilationSuccess
              : labels.compilationError
      });
      for (const test of problem.testCases) {
        const execution = test.execution;
        rows.push({
          [labels.candidate]: contestant.contestantName,
          [labels.problem]: problem.problemName,
          [labels.test]: test.name,
          [labels.score]: test.score,
          [labels.time]: `${(test.executionTime / 1000).toFixed(3)} ${labels.seconds}`,
          [labels.results]: describeTestResult(test),
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
  return contestant.problems.find(problem => problem.problemName.trim().toLowerCase() === problemName.trim().toLowerCase());
}

function emptyContestant(contestantName: string): ContestantResult {
  return { contestantName, problems: [] };
}

function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}
