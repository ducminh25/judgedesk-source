import path from "path";
import { isTextFile, readTextPreview } from "../file-utils.js";
import { activeJobs } from "../jobs.js";
import type {
  BatchJudgeRequest,
  ContestantResult,
  NormalizedProblemConfig,
  ProblemResult,
  TestCaseRun,
} from "../types.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";
import {
  compileSubmission,
  resolveChecker,
  type CompiledChecker,
} from "./compiler.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { calculateProblemSummary } from "./scoring.js";
import {
  createSubmissionResolver,
  listContestants,
  type Submission,
} from "./submission-discovery.js";
import {
  createProblemDirectoryResolver,
  discoverTestCases,
  type ProblemDirectory,
  type TestCaseFiles,
} from "./testcase-discovery.js";
import { runTestCase } from "./testcase-runner.js";
import {
  assertJudgeToolchainPreflight,
  type PinnedJudgeToolchains,
  type JudgeToolchainRequirements,
} from "./toolchain-preflight.js";
import { ensureCertifiedLocalCppSessionProbe } from "./certified-local-session-probe.js";

interface JudgeSessionOptions {
  request: Partial<BatchJudgeRequest>;
  contestantsDirectory: string;
  testDirectory: string;
  tempDirectory: string;
  events: JudgeEventWriter;
  pinnedToolchains: PinnedJudgeToolchains;
}

export interface PlannedTestCase {
  files: TestCaseFiles;
  inputIsText: boolean;
  expectedOutputPreview: string;
  score: number;
  timeLimitMs: number;
}

interface PlannedProblem {
  directory: ProblemDirectory;
  config: NormalizedProblemConfig;
  tests: PlannedTestCase[];
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
    submissions: new Set(),
    checkers: new Set(),
  };
  const pinnedSubmissions = new Map<string, Map<string, Submission | null>>();
  for (const contestant of contestantDirs) {
    const contestantPath = path.join(resolvedThisinh, contestant);
    const resolveSubmission = createSubmissionResolver(contestantPath);
    const submissions = new Map<string, Submission | null>();
    pinnedSubmissions.set(contestant, submissions);
    for (const targetProblem of activeProblemsList) {
      const submission = resolveSubmission(targetProblem);
      submissions.set(targetProblem, submission);
      if (submission) toolchainRequirements.submissions.add(submission.language);
    }
  }
  const plannedProblems = new Map<string, PlannedProblem>();
  for (const targetProblem of activeProblemsList) {
    const testProblemDirectory = getTestProblemDirObj(targetProblem);
    if (!testProblemDirectory) continue;
    const config = resolveProblemConfig(
      targetProblem,
      testProblemDirectory.path,
      request.problemConfigs?.[targetProblem],
    );
    plannedProblems.set(targetProblem.toLowerCase(), {
      directory: testProblemDirectory,
      config,
      tests: [],
    });
    const checker = config.checkerType.toLowerCase();
    if (checker.endsWith(".cpp")) toolchainRequirements.checkers.add("cpp");
    if (checker.endsWith(".py")) toolchainRequirements.checkers.add("python");
  }
  assertJudgeToolchainPreflight(toolchainRequirements, pinnedToolchains);
  if (
    toolchainRequirements.submissions.has("cpp")
    || toolchainRequirements.checkers.has("cpp")
  ) {
    sendEvent("progress", {
      contestant: "",
      problem: "",
      action: "Verifying certified compiler/runtime...",
      percent: 0,
    });
    await ensureCertifiedLocalCppSessionProbe(pinnedToolchains.cpp, tempDir, jobId);
  }
  sendEvent("progress", {
    contestant: "",
    problem: "",
    action: "Scanning submissions and testcases...",
    percent: 0,
  });
  for (const problem of plannedProblems.values()) {
    problem.tests = planProblemTestCases(problem.directory.path, problem.config);
  }
  console.info("[Judge] Toolchain pin", {
    jobId,
    cpp: {
      source: pinnedToolchains.cpp.source,
      certificateId: pinnedToolchains.cpp.certificateId,
      snapshotDigest: pinnedToolchains.cpp.snapshotDigest,
      version: pinnedToolchains.cpp.version,
    },
    c: {
      source: pinnedToolchains.c.source,
      certificateId: pinnedToolchains.c.certificateId,
      version: pinnedToolchains.c.version,
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
          language: "unknown",
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
      
      const plannedProblem = plannedProblems.get(targetProb.toLowerCase());
      if (!plannedProblem) {
         const missingResult: ProblemResult = {
           problemName: targetProb,
           language: "unknown",
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

      const probConf = plannedProblem.config;
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
        compile: probConf.compile,
        cppToolchain: pinnedToolchains.cpp,
        cToolchain: pinnedToolchains.c,
        pythonToolchain: pinnedToolchains.python,
        toolchains: pinnedToolchains,
      });
      const executablePath = compilation.executablePath;
      const compileTime = compilation.compileTime;
      let compileStatus = compilation.compileStatus;
      let compileError = compilation.compileError;

      const tcRuns: TestCaseRun[] = [];
      const tcDirEntries = plannedProblem.tests.map(testCase => testCase.files.name);

       if (compileStatus === "OK") {
         const cacheKey = `${problemName}_${checkerType}`;
         if (!(cacheKey in compiledCheckers)) {
           sendEvent("progress", {
             contestant,
             problem: problemName,
             action: `Compiling custom checker (${checkerType})...`,
             percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
           });
           compiledCheckers[cacheKey] = await resolveChecker({
             checkerType,
             problemName,
             problemDirectory: plannedProblem.directory.path,
             tempDirectory: tempDir,
             jobId,
             cppToolchain: pinnedToolchains.cpp,
             pythonToolchain: pinnedToolchains.python,
           });
         }
         const isStdIO = probConf.useStdIO;

         for (let i = 0; i < plannedProblem.tests.length; i++) {
             const plannedTestCase = plannedProblem.tests[i];
             const tcDir = plannedTestCase.files.name;
             if (jobId && activeJobs.get(jobId)?.cancel) break;
             const testFraction = plannedProblem.tests.length > 0 ? (i / plannedProblem.tests.length) : 0;
              const currentPercent = totalProblemsCount
                ? ((completedProblemsCount + testFraction) / totalProblemsCount) * 100
                : 0;
              sendEvent("progress", {
                contestant, problem: problemName,
                action: `Judging test ${i + 1} of ${tcDirEntries.length}`,
                percent: currentPercent,
              });
           const testFiles = plannedTestCase.files;
           const inpPath = testFiles.inputPath;
           const outPath = testFiles.outputPath;

           if (!plannedTestCase.inputIsText) {
             compileStatus = "CE";
             compileError = `Unreadable input file: ${testFiles.inputFileName}. Only text files are allowed.`;
             break;
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
             expectedOutputPreview: plannedTestCase.expectedOutputPreview,
             testRoot: testPath,
             contestantsRoot: thisinhPath,
             tempDirectory: tempDir,
             pythonCommand: language === "python" ? executablePath : "",
             timeLimitMs: plannedTestCase.timeLimitMs,
             score: plannedTestCase.score,
             config: probConf,
             checker: compiledCheckers[`${problemName}_${checkerType}`],
             program: compilation.program,
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

export function planProblemTestCases(
  problemDirectory: string,
  config: NormalizedProblemConfig,
): PlannedTestCase[] {
  const discovered = discoverTestCases(problemDirectory);
  const weighted = discovered.map(files => ({
    files,
    inputIsText: isTextFile(files.inputPath),
    expectedOutputPreview: readTextPreview(files.outputPath),
    weight: testCaseWeight(config, files.name),
    timeLimitMs: testCaseTimeLimitMs(config, files.name),
  }));
  const totalWeight = weighted.reduce((total, testCase) => total + testCase.weight, 0);
  return weighted.map(({ weight, ...testCase }) => ({
    ...testCase,
    score: testCaseScore(config, weight, totalWeight),
  }));
}

function testCaseWeight(config: NormalizedProblemConfig, testName: string): number {
  const polygonTest = config.polygonConfig?.tests?.[testName];
  if (polygonTest?.points !== undefined) return Number(polygonTest.points);
  if (config.testScores[testName] !== undefined) return Number(config.testScores[testName]);
  return config.defaultScore !== undefined ? Number(config.defaultScore) : 1;
}

function testCaseScore(
  config: NormalizedProblemConfig,
  weight: number,
  totalWeight: number,
): number {
  if (config.polygonConfig.enableGroups || config.totalScore === null) return weight;
  const score = totalWeight > 0 ? (weight / totalWeight) * Number(config.totalScore) : 0;
  return Math.round(score * 10_000) / 10_000;
}

function testCaseTimeLimitMs(config: NormalizedProblemConfig, testName: string): number {
  const timeLimit = config.polygonConfig?.tests?.[testName]?.timeLimit;
  return timeLimit === undefined ? 1_000 : Math.round(Number(timeLimit) * 1_000);
}
