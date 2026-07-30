import fs from "fs";
import path from "path";
import { isTextFile } from "../file-utils.js";
import { activeJobs } from "../jobs.js";
import type { BatchJudgeRequest, ContestantResult, ProblemResult, TestCaseRun } from "../types.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";
import {
  compileSubmission,
  resolveChecker,
  type CompiledChecker,
} from "./compiler.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { calculateProblemSummary } from "./scoring.js";
import {
  findSubmission,
  listContestants,
  type Submission,
} from "./submission-discovery.js";
import { createProblemDirectoryResolver, listTestDirectories, resolveTestCaseFiles } from "./testcase-discovery.js";
import { runTestCase } from "./testcase-runner.js";
import {
  assertJudgeToolchainPreflight,
  type JudgeToolchainRequirements,
} from "./toolchain-preflight.js";
import { ensureCertifiedLocalCppSessionProbe } from "./certified-local-session-probe.js";

interface JudgeSessionOptions {
  request: Partial<BatchJudgeRequest>;
  contestantsDirectory: string;
  testDirectory: string;
  tempDirectory: string;
  events: JudgeEventWriter;
  pinnedToolchains: Readonly<{
    cpp: Readonly<ResolvedToolchain>;
    python: Readonly<ResolvedToolchain>;
  }>;
}

export async function runJudgeSession(options: JudgeSessionOptions): Promise<void> {
  const {
    request,
    contestantsDirectory: resolvedThisinh,
    testDirectory: resolvedTest,
    tempDirectory: tempDir,
    events,
    pinnedToolchains,
  } = options;
  const thisinhPath = request.thisinhPath!;
  const testPath = request.testPath!;
  const { jobId } = request;
  const sendEvent = events.send;
  const getTestProblemDirObj = createProblemDirectoryResolver(resolvedTest);
  const contestantDirs = listContestants(resolvedThisinh, request.targetContestants);
  const contestants: ContestantResult[] = [];
  const targetProblems = Array.isArray(request.targetProblems) ? request.targetProblems : null;
  const activeProblemsList = targetProblems || [];
  const toolchainRequirements: JudgeToolchainRequirements = {
    cppSubmission: false,
    pythonSubmission: false,
    cppChecker: false,
    pythonChecker: false,
  };
  const pinnedSubmissions = new Map<string, Map<string, Submission | null>>();
  for (const contestant of contestantDirs) {
    const contestantPath = path.join(resolvedThisinh, contestant);
    const submissions = new Map<string, Submission | null>();
    pinnedSubmissions.set(contestant, submissions);
    for (const targetProblem of activeProblemsList) {
      const submission = findSubmission(contestantPath, targetProblem);
      submissions.set(targetProblem, submission);
      if (submission?.language === "cpp") toolchainRequirements.cppSubmission = true;
      if (submission?.language === "python") toolchainRequirements.pythonSubmission = true;
    }
  }
  for (const targetProblem of activeProblemsList) {
    const testProblemDirectory = getTestProblemDirObj(targetProblem);
    if (!testProblemDirectory) continue;
    const config = resolveProblemConfig(
      targetProblem,
      testProblemDirectory.path,
      request.problemConfigs?.[targetProblem],
    );
    const checker = config.checkerType.toLowerCase();
    if (checker.endsWith(".cpp")) toolchainRequirements.cppChecker = true;
    if (checker.endsWith(".py")) toolchainRequirements.pythonChecker = true;
  }
  assertJudgeToolchainPreflight(toolchainRequirements, pinnedToolchains);
  if (toolchainRequirements.cppSubmission || toolchainRequirements.cppChecker) {
    sendEvent("progress", {
      contestant: "",
      problem: "",
      action: "Verifying certified compiler/runtime...",
      percent: 0,
    });
    await ensureCertifiedLocalCppSessionProbe(pinnedToolchains.cpp, tempDir, jobId);
  }
  console.info("[Judge] Toolchain pin", {
    jobId,
    cpp: {
      source: pinnedToolchains.cpp.source,
      certificateId: pinnedToolchains.cpp.certificateId,
      snapshotDigest: pinnedToolchains.cpp.snapshotDigest,
      version: pinnedToolchains.cpp.version,
    },
    python: {
      source: pinnedToolchains.python.source,
      certificateId: pinnedToolchains.python.certificateId,
      version: pinnedToolchains.python.version,
    },
  });

  // Map compiled checkers to avoid recompiling
  const compiledCheckers: Record<string, CompiledChecker> = {};

  const totalProblemsCount = contestantDirs.length * (targetProblems ? targetProblems.length : 1);
  let completedProblemsCount = 0;

  for (const contestant of contestantDirs) {
    if (jobId && activeJobs.get(jobId)?.cancel) break;
    const contestantPath = path.join(resolvedThisinh, contestant);
    const problems: ProblemResult[] = [];
    for (const targetProb of activeProblemsList) {
      if (jobId && activeJobs.get(jobId)?.cancel) break;
      sendEvent("progress", {
        contestant, problem: targetProb,
        action: "Locating submission...",
        percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
      });

      const submission = pinnedSubmissions.get(contestant)?.get(targetProb) ?? null;
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
        jobId,
        cppToolchain: pinnedToolchains.cpp,
        pythonToolchain: pinnedToolchains.python,
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
             jobId,
             cppToolchain: pinnedToolchains.cpp,
             pythonToolchain: pinnedToolchains.python,
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
           let tcTimeLimitMs = 1_000;
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
           if (jobId && activeJobs.get(jobId)?.cancel) break;
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
