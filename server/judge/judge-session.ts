import fs from "fs";
import path from "path";
import { isTextFile, readTextPreview } from "../file-utils.js";
import { activeJobs, JudgeJobCancelledError } from "../jobs.js";
import type {
  BatchJudgeRequest,
  ContestantResult,
  NormalizedProblemConfig,
  ProblemResult,
  TestCaseRun,
} from "../types.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";
import { validateProblemTestInputs } from "../problems/test-wellformed.js";
import {
  compileSubmission,
  resolveChecker,
  resolveInteractor,
  type CompiledChecker,
  type CompiledInteractor,
  type CompilationResult,
} from "./compiler.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { calculateProblemSummary } from "./scoring.js";
import {
  addRational,
  createRational,
  divideRational,
  multiplyRational,
  parseRational,
  rationalToNumber,
  type Rational,
} from "../../shared/rational.js";
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
import {
  ensureJudgePrewarmReady,
  nativeCompilerKindsToPrewarm,
} from "./background-prewarm.js";
import type { ToolchainKind } from "../toolchains/types.js";

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
  scoreExact: Rational;
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
  if (jobId && activeJobs.get(jobId)?.cancel) return;
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
    if (config.isInteractive && config.interactor) {
      const interactor = config.interactor.toLowerCase();
      if (interactor.endsWith(".cpp")) toolchainRequirements.checkers.add("cpp");
      if (interactor.endsWith(".py")) toolchainRequirements.checkers.add("python");
    }
  }
  assertJudgeToolchainPreflight(toolchainRequirements, pinnedToolchains);
  const nativePrewarmRequirements = new Set<ToolchainKind>([
    ...toolchainRequirements.submissions,
    ...toolchainRequirements.checkers,
  ]);
  const nativePrewarmKinds = nativeCompilerKindsToPrewarm(nativePrewarmRequirements);
  if (nativePrewarmKinds.length > 0) {
    if (jobId && activeJobs.get(jobId)?.cancel) return;
    sendEvent("progress", {
      contestant: "",
      problem: "",
      action: "progress.verifyingEnvironment",
      percent: 0,
    });
    try {
      await ensureJudgePrewarmReady(pinnedToolchains.cpp, tempDir, jobId, undefined, nativePrewarmKinds);
    } catch (error) {
      if (
        error instanceof JudgeJobCancelledError
        || (jobId && activeJobs.get(jobId)?.cancel)
      ) {
        return;
      }
      throw error;
    }
  }
  if (jobId && activeJobs.get(jobId)?.cancel) return;
  sendEvent("progress", {
    contestant: "",
    problem: "",
    action: "progress.scanning",
    percent: 0,
  });
  for (const problem of plannedProblems.values()) {
    if (jobId && activeJobs.get(jobId)?.cancel) return;
    if (problem.config.testWellFormed) {
      const validation = await validateProblemTestInputs(problem.directory.path, problem.config.isInteractive);
      if (jobId && activeJobs.get(jobId)?.cancel) return;
      if (validation.issues.length > 0) {
        const first = validation.issues[0];
        throw new Error(`Test input is not well-formed: ${first.testName}/${first.fileName}:${first.line}:${first.column} (${first.code}); ${validation.issues.length} issue(s)`);
      }
    }
    problem.tests = planProblemTestCases(problem.directory.path, problem.config);
  }
  if (jobId && activeJobs.get(jobId)?.cancel) return;
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
  const compiledInteractors: Record<string, CompiledInteractor> = {};

  const totalProblemsCount = contestantDirs.length * (targetProblems ? targetProblems.length : 1);
  let completedProblemsCount = 0;

  for (const contestant of contestantDirs) {
    if (jobId && activeJobs.get(jobId)?.cancel) break;
    const problems: ProblemResult[] = [];
    for (const targetProb of activeProblemsList) {
      if (jobId && activeJobs.get(jobId)?.cancel) break;
      sendEvent("progress", {
        contestant, problem: targetProb,
        action: "progress.locating",
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

      const unreadableTest = plannedProblem.tests.find(test => !test.inputIsText);
      if (!unreadableTest) sendEvent("progress", {
        contestant, problem: problemName,
        action: "progress.compilingSubmission",
        percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
      });

      const probConf = plannedProblem.config;
      const checkerType = probConf.checkerType;
      const useStdIn = probConf.useStdIn;
      const useStdOut = probConf.useStdOut;
      const outputFilename = useStdOut ? "stdout" : probConf.outputFile;

      const subPath = submission.filePath;
      // Reject a known-invalid judge test plan before touching student source.
      // JE here means setup never reached compilation, not a failed compiler.
      const compilation: CompilationResult = unreadableTest ? {
        executablePath: "", compileStatus: "JE", compileTime: 0, failureKind: "infrastructure",
        compileError: `Unreadable input file: ${unreadableTest.files.inputFileName}. Only text files are allowed.`,
      } : await compileSubmission({
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
      if (jobId && activeJobs.get(jobId)?.cancel) break;
      const executablePath = compilation.executablePath;
      const compileTime = compilation.compileTime;
      const compileStatus = compilation.compileStatus;
      const compileError = compilation.compileError;

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
            const resolvedChecker = await resolveChecker({
              checkerType,
              problemName,
              problemDirectory: plannedProblem.directory.path,
              tempDirectory: tempDir,
              jobId,
              cppToolchain: pinnedToolchains.cpp,
              pythonToolchain: pinnedToolchains.python,
            });
            if (jobId && activeJobs.get(jobId)?.cancel) break;
            compiledCheckers[cacheKey] = resolvedChecker;
          }

          let compiledInteractor: CompiledInteractor | undefined;
          if (probConf.isInteractive) {
            const interactorKey = `${problemName}_${probConf.interactor || "interactor.cpp"}`;
            if (!(interactorKey in compiledInteractors)) {
              sendEvent("progress", {
                contestant,
                problem: problemName,
                action: `Compiling interactor (${probConf.interactor || "interactor.cpp"})...`,
                percent: totalProblemsCount ? (completedProblemsCount / totalProblemsCount) * 100 : 0
              });
              const resolvedInteractor = await resolveInteractor({
                interactorName: probConf.interactor || "interactor.cpp",
                problemName,
                problemDirectory: plannedProblem.directory.path,
                tempDirectory: tempDir,
                jobId,
                cppToolchain: pinnedToolchains.cpp,
                pythonToolchain: pinnedToolchains.python,
              });
              if (jobId && activeJobs.get(jobId)?.cancel) break;
              compiledInteractors[interactorKey] = resolvedInteractor;
            }
            compiledInteractor = compiledInteractors[interactorKey];
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
             scoreExact: plannedTestCase.scoreExact,
             config: probConf,
             checker: compiledCheckers[`${problemName}_${checkerType}`],
             interactor: compiledInteractor,
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
  const discovered = discoverTestCases(problemDirectory, config.isInteractive);
  const weighted = discovered.map(files => ({
    files,
    inputIsText: isTextFile(files.inputPath),
    expectedOutputPreview: files.outputPath && fs.existsSync(files.outputPath)
      ? readTextPreview(files.outputPath)
      : (config.isInteractive ? "[Interactive]" : ""),
    weight: testCaseWeight(config, files.name),
    timeLimitMs: testCaseTimeLimitMs(config, files.name),
  }));
  const totalWeight = weighted.reduce((total, testCase) => addRational(total, testCase.weight), createRational(0));
  return weighted.map(({ weight, ...testCase }) => {
    const scoreExact = testCaseScore(config, weight, totalWeight);
    return { ...testCase, scoreExact, score: rationalToNumber(scoreExact) };
  });
}

export function testCaseWeight(config: NormalizedProblemConfig, testName: string): Rational {
  const polygonTest = config.polygonConfig?.tests?.[testName];
  if (polygonTest?.points !== undefined) return parseRational(polygonTest.points);
  if (config.testScores[testName] !== undefined) return parseRational(config.testScores[testName]);
  return config.defaultScore !== undefined ? parseRational(config.defaultScore) : createRational(1);
}

export function testCaseScore(
  config: NormalizedProblemConfig,
  weight: Rational,
  totalWeight: Rational,
): Rational {
  if (config.polygonConfig.enableGroups || config.totalScore === null || config.totalScore === undefined || config.totalScore === "") {
    return weight;
  }
  const totalScoreRat = parseRational(config.totalScore);
  if (BigInt(totalWeight.n) === 0n) return createRational(0);
  const scoreRat = divideRational(
    multiplyRational(weight, totalScoreRat),
    totalWeight
  );
  return scoreRat;
}

function testCaseTimeLimitMs(config: NormalizedProblemConfig, testName: string): number {
  const timeLimit = config.polygonConfig?.tests?.[testName]?.timeLimit;
  return timeLimit === undefined ? 1_000 : Math.round(Number(timeLimit) * 1_000);
}
