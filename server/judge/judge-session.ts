import fs from "fs";
import path from "path";
import { isTextFile } from "../file-utils.js";
import { activeJobs } from "../jobs.js";
import type { BatchJudgeRequest, ContestantResult, ProblemResult, TestCaseRun } from "../types.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";
import { compileSubmission, resolveChecker, type CompiledChecker } from "./compiler.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { calculateProblemSummary } from "./scoring.js";
import { findSubmission, listContestants } from "./submission-discovery.js";
import { createProblemDirectoryResolver, listTestDirectories, resolveTestCaseFiles } from "./testcase-discovery.js";
import { runTestCase } from "./testcase-runner.js";

interface JudgeSessionOptions {
  request: Partial<BatchJudgeRequest>;
  contestantsDirectory: string;
  testDirectory: string;
  tempDirectory: string;
  events: JudgeEventWriter;
}

export async function runJudgeSession(options: JudgeSessionOptions): Promise<void> {
  const { request, contestantsDirectory: resolvedThisinh, testDirectory: resolvedTest, tempDirectory: tempDir, events } = options;
  const thisinhPath = request.thisinhPath!;
  const testPath = request.testPath!;
  const { timeLimit, jobId } = request;
  const timeLimitInput = parseInt(String(timeLimit || "1000"), 10);
  const sendEvent = events.send;
  const getTestProblemDirObj = createProblemDirectoryResolver(resolvedTest);
  const contestantDirs = listContestants(resolvedThisinh, request.targetContestants);
  const contestants: ContestantResult[] = [];

  // Map compiled checkers to avoid recompiling
  const compiledCheckers: Record<string, CompiledChecker> = {};

  const targetProblems = Array.isArray(request.targetProblems) ? request.targetProblems : null;
  const totalProblemsCount = contestantDirs.length * (targetProblems ? targetProblems.length : 1);
  let completedProblemsCount = 0;

  for (const contestant of contestantDirs) {
    if (jobId && activeJobs.get(jobId)?.cancel) break;
    const contestantPath = path.join(resolvedThisinh, contestant);
    const problems: ProblemResult[] = [];
    const activeProblemsList = targetProblems || [];

    for (const targetProb of activeProblemsList) {
      if (jobId && activeJobs.get(jobId)?.cancel) break;
      sendEvent("progress", {
        contestant, problem: targetProb,
        action: "Locating submission...",
        percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
      });

      const submission = findSubmission(contestantPath, targetProb);
      if (!submission) {
        const missingResult: ProblemResult = {
          problemName: targetProb,
          language: "cpp",
          compileStatus: "SKIPPED",
          compileError: "not_found",
          testCases: [],
          summary: {
            total: 0,
            passed: 0,
            maxScore: 0,
            score: 0,
            status: "FAIL"
          }
        };
        problems.push(missingResult);
        completedProblemsCount++;
        sendEvent("problem_completed", { contestant, problemResult: missingResult });
        continue;
      }

      const { problemName, language } = submission;
      
      const testProblemDir = getTestProblemDirObj(problemName);
      if (!testProblemDir) {
         const missingResult: ProblemResult = {
           problemName: targetProb,
           language: "cpp",
           compileStatus: "SKIPPED",
           compileError: "not_found",
           testCases: [],
           summary: {
             total: 0,
             passed: 0,
             maxScore: 0,
             score: 0,
             status: "FAIL"
           }
         };
         problems.push(missingResult);
         completedProblemsCount++;
         sendEvent("problem_completed", { contestant, problemResult: missingResult });
         continue;
      }

      sendEvent("progress", {
        contestant, problem: problemName,
        action: "Compiling...",
        percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
      });

      const probConf = resolveProblemConfig(
        problemName,
        testProblemDir.path,
        request.problemConfigs?.[problemName]
      );
      const checkerType = probConf.checkerType;
      const useStdIn = probConf.useStdIn;
      const useStdOut = probConf.useStdOut;
      const outputFilename = useStdOut ? "stdout" : probConf.outputFile;

      const subPath = submission.filePath;
      const compilation = await compileSubmission({
        language,
        contestantName: contestant,
        problemName,
        submissionPath: subPath,
        tempDirectory: tempDir,
        jobId
      });
      const executablePath = compilation.executablePath;
      const compileTime = compilation.compileTime;
      let compileStatus = compilation.compileStatus;
      let compileError = compilation.compileError;

      const tcRuns: TestCaseRun[] = [];
      const tcDirEntries = listTestDirectories(testProblemDir.path);

       if (compileStatus === "OK") {
         const cacheKey = `${problemName}_${checkerType}`;
         if (!(cacheKey in compiledCheckers)) {
           compiledCheckers[cacheKey] = await resolveChecker({
             checkerType,
             problemName,
             problemDirectory: testProblemDir.path,
             tempDirectory: tempDir,
             jobId
           });
         }
         const poly = probConf.polygonConfig;
         const isStdIO = probConf.useStdIO;

         let totalWeight = 0;
         for (const tc of tcDirEntries) {
             let w = probConf.defaultScore !== undefined ? Number(probConf.defaultScore) : 1;
             if (poly && poly.tests && poly.tests[tc] && poly.tests[tc].points !== undefined) {
                 w = Number(poly.tests[tc].points);
             } else if (probConf.testScores[tc] !== undefined) {
                 w = Number(probConf.testScores[tc]);
             }
             totalWeight += w;
         }

         for (let i = 0; i < tcDirEntries.length; i++) {
             const tcDir = tcDirEntries[i];
             if (jobId && activeJobs.get(jobId)?.cancel) break;
             sendEvent("progress", {
               contestant, problem: problemName,
               action: `Judging test ${i + 1} of ${tcDirEntries.length}`,
               percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
             });
           const testFiles = resolveTestCaseFiles(testProblemDir.path, tcDir);
           if (!testFiles) continue;
           const inpPath = testFiles.inputPath;
           const outPath = testFiles.outputPath;
           const outputStringTarget = fs.readFileSync(outPath, "utf8");

           if (!isTextFile(inpPath)) {
             compileStatus = "CE";
             compileError = `Unreadable input file: ${testFiles.inputFileName}. Only text files are allowed.`;
             break;
           }

           // Determine the specific score for this test case
           let weightForTc: number = probConf.defaultScore !== undefined ? Number(probConf.defaultScore) : 1;
           if (poly && poly.tests && poly.tests[tcDir] && poly.tests[tcDir].points !== undefined) {
               weightForTc = Number(poly.tests[tcDir].points);
           } else if (probConf.testScores[tcDir] !== undefined) {
               weightForTc = Number(probConf.testScores[tcDir]);
           }
           
           let scoreForTc = weightForTc;
           const totalScoreInput = probConf.totalScore;
           // Polygon config overrides proportional scoring
           if (!poly.enableGroups && totalScoreInput !== null) {
               if (totalWeight > 0) {
                  scoreForTc = (weightForTc / totalWeight) * Number(totalScoreInput);
               } else {
                  scoreForTc = 0;
               }
               scoreForTc = Math.round(scoreForTc * 10000) / 10000;
           }

           // Determine specific time limit for this test case
           let tcTimeLimitMs = timeLimitInput;
           if (poly && poly.tests && poly.tests[tcDir] && poly.tests[tcDir].timeLimit !== undefined) {
               tcTimeLimitMs = Math.round(Number(poly.tests[tcDir].timeLimit) * 1000);
           }

           const tcRes = await runTestCase({
             contestant,
             problemName,
             testName: tcDir,
             language,
             submissionPath: subPath,
             executablePath,
             inputPath: inpPath,
             expectedOutputPath: outPath,
             expectedOutput: outputStringTarget,
             testRoot: testPath,
             contestantsRoot: thisinhPath,
             tempDirectory: tempDir,
             pythonCommand: language === "python" ? executablePath : "",
             timeLimitMs: tcTimeLimitMs,
             score: scoreForTc,
             config: probConf,
             checker: compiledCheckers[`${problemName}_${checkerType}`],
             jobId
           });
           tcRuns.push(tcRes);
         }
      }

      const summary = calculateProblemSummary({
        compileStatus,
        testCases: tcRuns,
        testDirectories: tcDirEntries,
        config: probConf
      });
      const probResult: ProblemResult = {
        problemName,
        language,
        compileStatus,
        compileError,
        compileTime,
        testCases: tcRuns,
        summary
      };
      if (jobId && activeJobs.get(jobId)?.cancel) break;
      problems.push(probResult);
      completedProblemsCount++;
      sendEvent("problem_completed", { contestant, problemResult: probResult });
    }

    if (problems.length > 0) {
      contestants.push({ contestantName: contestant, problems });
    }
  }

}
