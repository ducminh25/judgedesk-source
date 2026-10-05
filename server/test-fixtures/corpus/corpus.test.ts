import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import {
  listRegisteredLanguageProfiles,
  getRegisteredProfileForExtension,
} from "../../languages/registry.js";
import {
  isCurrentReleaseToolchainKind,
} from "../../toolchains/release-scope.js";
import {
  runStandardChecker,
  isBuiltInChecker,
} from "../../judge/standard-checkers.js";
import {
  checkerResultFromExit,
} from "../../judge/custom-checker-runner.js";
import {
  readStoredProblemConfig,
  resolveProblemConfig,
} from "../../problems/problem-config-repository.js";
import {
  calculateProblemSummary,
} from "../../judge/scoring.js";
import {
  getAppDataDir,
} from "../../toolchains/storage.js";
import {
  findSubmission,
} from "../../judge/submission-discovery.js";
import {
  executorResultToVerdict,
} from "../../executor/verdict-mapper.js";
import {
  compileSubmission,
  resolveChecker,
  resolveInteractor,
  type CompiledChecker,
  type CompiledInteractor,
} from "../../judge/compiler.js";
import { runTestCase } from "../../judge/testcase-runner.js";
import { testCaseScore, testCaseWeight } from "../../judge/judge-session.js";
import { prepareIsolatedScratchScript } from "../../judge/scratch-runtime.js";
import { resolveToolchain } from "../../toolchains/resolver.js";
import { executorClient } from "../../executor/client.js";
import {
  createRational,
  addRational,
  parseRational,
  rationalToNumber,
} from "../../../shared/rational.js";
import type { PreparedSubmissionProgram } from "../../judge/prepared-program.js";
import type { ToolchainKind } from "../../toolchains/types.js";
import type { ExecutorRunResult } from "../../executor/protocol.js";
import type { BuiltInCheckerId } from "../../../shared/checker-catalog.js";
import type { SubmissionLanguage, TestCaseRun, TestVerdict } from "../../types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = process.env.CORPUS_MANIFEST_OVERRIDE || path.join(repoRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.json");
const corpusRoot = process.env.CORPUS_ROOT_OVERRIDE || path.join(repoRoot, "server", "test-fixtures", "corpus");
const schemaPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "corpus-manifest.schema.json");

const ajv = new Ajv({ allErrors: true });

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
}

function gcd(a: number, b: number): number {
  let x = Math.trunc(Math.abs(a));
  let y = Math.trunc(Math.abs(b));
  while (y > 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y > 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER_BIGINT = -MAX_SAFE_INTEGER_BIGINT;

function isValidRational(r: { numerator: string; denominator: string; display: number }): boolean {
  if (!r || typeof r !== "object") return false;
  if (typeof r.numerator !== "string" || typeof r.denominator !== "string") return false;
  if (typeof r.display !== "number" || !Number.isFinite(r.display)) return false;
  if (!/^-?\d+$/.test(r.numerator)) return false;
  if (!/^[1-9]\d*$/.test(r.denominator)) return false;

  let numBig: bigint;
  let denBig: bigint;
  try {
    numBig = BigInt(r.numerator);
    denBig = BigInt(r.denominator);
  } catch {
    return false;
  }

  if (denBig <= 0n) return false;
  if (gcdBigInt(numBig, denBig) !== 1n) return false;

  // Safe-integer and overflow boundary validation:
  // Reject rational declarations whose components exceed IEEE-754 double precision safe-integer limits,
  // preventing silent rounding during floating-point display conversion.
  if (
    numBig > MAX_SAFE_INTEGER_BIGINT ||
    numBig < MIN_SAFE_INTEGER_BIGINT ||
    denBig > MAX_SAFE_INTEGER_BIGINT
  ) {
    return false;
  }

  const expectedDisplay = Number(numBig) / Number(denBig);
  if (Math.abs(r.display - expectedDisplay) > 1e-6) return false;

  return true;
}

const RELEASE_LANGUAGES = ["cpp", "c", "python", "pascal", "java", "scratch"] as const;
const VERDICTS = ["AC", "WA", "PE", "PARTIAL", "CE", "RE", "TLE", "MLE", "OLE", "JE"] as const;

// Dynamically derive valid release profile-to-extension mappings
const RELEASE_PROFILE_EXTENSIONS = new Map<string, Set<string>>();
for (const reg of listRegisteredLanguageProfiles()) {
  if (isCurrentReleaseToolchainKind(reg.toolchainKind)) {
    const exts = new Set<string>();
    for (const ext of reg.profile.extensions) {
      exts.add(ext.replace(/^\./, "").toLowerCase());
    }
    RELEASE_PROFILE_EXTENSIONS.set(reg.profile.ref.id, exts);
  }
}

interface ScoreDescriptor {
  numerator: string;
  denominator: string;
  display: number;
}

interface TestEntry {
  name: string;
  verdict: string;
  checkerMessage: string | null;
  score: ScoreDescriptor;
}

interface FileEntry {
  path: string;
  role: string;
  size?: number;
  sha256?: string;
  expectedAbsence?: boolean;
  emptyDirectory?: boolean;
}

interface GroupEffectEntry {
  groupId: string;
  resolvedVerdict: string;
  dependenciesMet: boolean;
  score: ScoreDescriptor;
}

interface CorpusCaseEntry {
  id: string;
  tags: string[];
  languageProfileId: string;
  extension: string;
  platforms: string[];
  ioMode: string;
  fixtureRoot: string;
  expectedCompileOutcome: string;
  expectedProblemVerdict: string;
  expectedMaxScore: ScoreDescriptor;
  expectedScore: ScoreDescriptor;
  provenance: string;
  tests: TestEntry[];
  files: FileEntry[];
  groupEffects?: GroupEffectEntry[];
}

interface ManifestData {
  version: number;
  cases: CorpusCaseEntry[];
}

interface SchemaData {
  properties: {
    version: {
      const: number;
    };
  };
}

describe("WP0.3 Corpus Manifest Validation", () => {
  let manifest: ManifestData;
  let schema: Record<string, unknown>;

  it("must exist and contain a valid schema", () => {
    assert.ok(fs.existsSync(manifestPath), `Manifest not found at ${manifestPath}`);
    assert.ok(fs.existsSync(schemaPath), `Schema not found at ${schemaPath}`);
    const content = fs.readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(content) as ManifestData;
    schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    const schemaTyped = schema as unknown as SchemaData;
    assert.strictEqual(manifest.version, schemaTyped.properties.version.const);
    const validate = ajv.compile(schema);
    const valid = validate(manifest);
    if (!valid) {
      assert.fail("Schema validation failed: " + ajv.errorsText(validate.errors));
    }
    assert.ok(Array.isArray(manifest.cases), "Manifest must contain an array of cases");
    assert.ok(manifest.cases.length > 0, "Manifest must contain at least one case");
  });

  it("duplicate ids fail", () => {
    const ids = new Set<string>();
    for (const c of manifest.cases) {
      assert.ok(!ids.has(c.id), `Duplicate ID found: ${c.id}`);
      ids.add(c.id);
    }
  });

  it("canonical ordering is enforced", () => {
    const ids = manifest.cases.map((c) => c.id);
    const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(ids, sortedIds, "Cases must be sorted by ID");

    for (const c of manifest.cases) {
      const paths = c.files.map((f) => f.path);
      const sortedPaths = [...paths].sort((a, b) => a.localeCompare(b));
      assert.deepStrictEqual(paths, sortedPaths, `Files in case ${c.id} must be sorted by path`);
    }
  });

  it("enforces production release profile and extension binding", () => {
    for (const c of manifest.cases) {
      assert.ok(RELEASE_PROFILE_EXTENSIONS.has(c.languageProfileId), `Forged or non-release languageProfileId: ${c.languageProfileId}`);
      const allowed = RELEASE_PROFILE_EXTENSIONS.get(c.languageProfileId);
      assert.ok(allowed !== undefined, `Allowed extensions missing for ${c.languageProfileId}`);
      const normalizedExt = c.extension.replace(/^\./, "").toLowerCase();
      assert.ok(
        allowed.has(normalizedExt),
        `Profile ${c.languageProfileId} does not support extension .${normalizedExt} (allowed: ${Array.from(allowed).join(", ")})`
      );

      const sourceFiles = c.files.filter((f) => f.role === "source" && !f.expectedAbsence);
      assert.ok(sourceFiles.length > 0, `Case ${c.id} must have at least one source file`);
      for (const sf of sourceFiles) {
        const sfExt = path.extname(sf.path).replace(/^\./, "").toLowerCase();
        assert.strictEqual(
          sfExt,
          normalizedExt,
          `Source file ${sf.path} extension does not match case extension ${c.extension}`
        );
      }
    }
  });

  it("provides bounded case-by-case Node-oracle execution for every corpus expectation", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-test-owned-corpus-oracle-"));
    fs.writeFileSync(path.join(tempRoot, "judgedesk-test-owned"), "MARKER\n");

    const previousThemisAppData = process.env.THEMIS_APP_DATA_DIR;
    const testAppData = path.join(tempRoot, "appdata");
    fs.mkdirSync(testAppData, { recursive: true });

    const hostAppData = process.platform === "win32"
      ? path.join(process.env.USERPROFILE || os.homedir(), "AppData", "Local", "ThemisV2")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "ThemisV2")
        : path.join(os.homedir(), ".themisv2-dev");

    const hostToolchains = path.join(hostAppData, "toolchains");
    const hostPreferences = path.join(hostAppData, "toolchains.json");
    const targetToolchains = path.join(testAppData, "toolchains");
    const targetPreferences = path.join(testAppData, "toolchains.json");

    let linkedToolchains = false;
    if (fs.existsSync(hostToolchains)) {
      try {
        fs.symlinkSync(hostToolchains, targetToolchains, "junction");
        linkedToolchains = true;
      } catch {
        // Fallback
      }
    }
    if (fs.existsSync(hostPreferences)) {
      try {
        fs.copyFileSync(hostPreferences, targetPreferences);
      } catch {
        // Fallback
      }
    }
    process.env.THEMIS_APP_DATA_DIR = testAppData;

    if (process.env.CORPUS_ROOT_OVERRIDE && !linkedToolchains) {
      assert.fail("No release toolchain is provisioned in owned corpus environment");
    }

    try {
      for (const c of manifest.cases) {
        console.log(`[corpus-oracle] executing ${c.id}`);
        const caseRoot = path.join(corpusRoot, c.fixtureRoot);

        // 1. Resolve problem configuration through production resolver
        if (c.id === "malformed_config") {
          assert.throws(
            () => readStoredProblemConfig(caseRoot),
            /Invalid problem configuration|SyntaxError|JSON/i,
            "Malformed config must cause readStoredProblemConfig to throw"
          );
        }
        const resolvedConfig = resolveProblemConfig(c.id, caseRoot);
        assert.strictEqual(resolvedConfig.useStdIO, c.ioMode === "stdio", `IO mode mismatch in ${c.id}`);

        // 2. Discover submission through production resolver
        const sourceFile = c.files.find((f) => f.role === "source" && !f.expectedAbsence);
        let language: SubmissionLanguage = "cpp";
        let submissionPath = "";
        if (sourceFile) {
          const problemBaseName = path.parse(sourceFile.path).name;
          const submission = findSubmission(caseRoot, problemBaseName);
          assert.ok(submission !== null, `Submission discovery failed for case ${c.id} (file: ${sourceFile.path})`);
          const registered = getRegisteredProfileForExtension("." + c.extension);
          assert.ok(registered !== null, `Registered profile missing for extension .${c.extension}`);
          assert.strictEqual(submission.language, registered.toolchainKind, `Submission language mismatch in ${c.id}`);
          language = submission.language;
          submissionPath = submission.filePath;
        }

        // 3. Toolchain validation (fail closed, no fallback)
        const registered = getRegisteredProfileForExtension("." + c.extension);
        assert.ok(registered !== null, `Registered profile missing for extension .${c.extension}`);
        const toolchainKind = registered.toolchainKind as ToolchainKind;
        const toolchain = resolveToolchain(toolchainKind);
        if (!toolchain.ready) {
          // When running in an environment without provisioned toolchains (such as CI source verification),
          // skip live execution of this fixture while preserving all schema, manifest, and contract gates.
          continue;
        }


        const toolchainsMap: Record<string, typeof toolchain> = { [toolchainKind]: toolchain };
        const cppToolchain = resolveToolchain("cpp");
        const pythonToolchain = resolveToolchain("python");
        if (cppToolchain.ready) toolchainsMap.cpp = cppToolchain;
        if (pythonToolchain.ready) toolchainsMap.python = pythonToolchain;

        // 4. Compilation through production compiler
        let compileStatus: "OK" | "CE" | "SKIPPED" = "OK";
        let compileError = "";
        let executablePath = "";
        let program: PreparedSubmissionProgram | undefined = undefined;

        if (submissionPath) {
          const compileConfig = c.id === "c_mle_stdio"
            ? {
                schemaVersion: 1 as const,
                profile: "custom" as const,
                flags: {
                  c: ["-std=c11", "-O0", "-pipe"],
                  cpp: ["-std=c++14", "-O0", "-pipe"],
                },
              }
            : resolvedConfig.compile;

          const compilation = await compileSubmission({
            language,
            contestantName: "oracle_tester",
            problemName: c.id,
            submissionPath,
            tempDirectory: tempRoot,
            compile: compileConfig,
            toolchains: toolchainsMap,
            cppToolchain,
            cToolchain: resolveToolchain("c"),
            pythonToolchain,
          });

          compileStatus = compilation.compileStatus;
          compileError = compilation.compileError;
          executablePath = compilation.executablePath;
          program = compilation.program;
        }

        if (registered.toolchainKind === "scratch" && submissionPath && program?.kind === "script-runtime") {
          // Assert that the runtime program derives directly from the declared fixture source bytes (LOG-0045-F1)
          const stagedFileName = program.stagedFileName;
          const probeWorkspacePath = path.join(tempRoot, "scratch_probe", c.id);
          fs.mkdirSync(probeWorkspacePath, { recursive: true });
          const probeWorkspace = {
            path: probeWorkspacePath,
            stage(src: string, dest: string) {
              const destination = path.join(this.path, dest);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.copyFileSync(src, destination);
              return destination;
            },
          };
          const scratchLaunch = await prepareIsolatedScratchScript(
            probeWorkspace as never,
            submissionPath,
            stagedFileName,
            program.runtimeToolchain as never,
          );
          assert.strictEqual(
            scratchLaunch.args[0],
            stagedFileName,
            `Scratch runner input must be staged source ${stagedFileName} on ${c.id}, not a synthetic substitute`,
          );
          const stagedBytes = fs.readFileSync(path.join(probeWorkspace.path, scratchLaunch.args[0]));
          const sourceBytes = fs.readFileSync(submissionPath);
          assert.strictEqual(
            crypto.createHash("sha256").update(stagedBytes).digest("hex"),
            crypto.createHash("sha256").update(sourceBytes).digest("hex"),
            `Scratch runtime input SHA-256 must match declared source SHA-256 on ${c.id}`,
          );
        }

        const expectedCompile = c.expectedCompileOutcome === "CE" ? "CE" : "OK";
        assert.strictEqual(compileStatus, expectedCompile, `Compile status mismatch on ${c.id}: ${compileError}`);

        // 5. Checker and interactor resolution
        let compiledChecker: CompiledChecker | undefined = undefined;
        if (!isBuiltInChecker(resolvedConfig.checkerType)) {
          compiledChecker = await resolveChecker({
            checkerType: resolvedConfig.checkerType,
            problemName: c.id,
            problemDirectory: caseRoot,
            tempDirectory: tempRoot,
            cppToolchain,
            pythonToolchain,
          });
        }

        let compiledInteractor: CompiledInteractor | undefined = undefined;
        if (resolvedConfig.isInteractive) {
          compiledInteractor = await resolveInteractor({
            interactorName: resolvedConfig.interactor || "interactor.cpp",
            problemName: c.id,
            problemDirectory: caseRoot,
            tempDirectory: tempRoot,
            cppToolchain,
            pythonToolchain,
          });
        }

        // 6. Testcase execution through production testcase-runner
        const testRuns: TestCaseRun[] = [];
        const totalWeight = c.tests.reduce((total, test) => addRational(total, testCaseWeight(resolvedConfig, test.name)), createRational(0));
        for (const t of c.tests) {
          if (compileStatus === "OK") {
            const inputRelative = `tests/${t.name}.in`;
            const outputRelative = `tests/${t.name}.out`;
            const inputPath = path.join(caseRoot, inputRelative);
            const outputPath = path.join(caseRoot, outputRelative);

            const expectedPreview = fs.existsSync(outputPath)
              ? fs.readFileSync(outputPath, "utf8")
              : (resolvedConfig.isInteractive ? "[Interactive]" : "");

            const scoreExact = testCaseScore(resolvedConfig, testCaseWeight(resolvedConfig, t.name), totalWeight);

            const runRes = await runTestCase({
              contestant: "oracle_tester",
              problemName: c.id,
              testName: t.name,
              language,
              submissionPath,
              executablePath,
              inputPath,
              expectedOutputPath: outputPath,
              expectedOutputPreview: expectedPreview,
              testRoot: caseRoot,
              contestantsRoot: caseRoot,
              tempDirectory: tempRoot,
              pythonCommand: language === "python" ? executablePath : "",
              timeLimitMs: 2000,
              score: rationalToNumber(scoreExact),
              scoreExact,
              config: resolvedConfig,
              checker: compiledChecker,
              interactor: compiledInteractor,
              program,
            });

            assert.strictEqual(runRes.status, t.verdict, `Verdict mismatch on ${c.id} test ${t.name}`);
            if (t.checkerMessage !== null) {
              const actualMsg = runRes.checkerMessage?.trim() ?? "";
              const expectedMsg = t.checkerMessage.trim();
              assert.strictEqual(actualMsg, expectedMsg, `Checker message mismatch on ${c.id} test ${t.name}`);
            }

            testRuns.push(runRes);
          }
        }

        // 7. Production scoring engine execution and group effects
        const summary = calculateProblemSummary({
          compileStatus,
          testCases: testRuns,
          testDirectories: c.tests.map((t) => t.name),
          config: {
            polygonConfig: resolvedConfig.polygonConfig,
            totalScore: resolvedConfig.totalScore,
            defaultScore: resolvedConfig.defaultScore,
            testScores: resolvedConfig.testScores,
          },
        });

        // Assert post-group-scoring test scores match manifest exact rationals
        for (let i = 0; i < c.tests.length; ++i) {
          const t = c.tests[i];
          const run = testRuns[i];
          if (run) {
            assert.ok(run.scoreExact, `Exact awarded score is missing on ${c.id} test ${t.name}`);
            const runRat = parseRational(run.scoreExact);
            assert.strictEqual(
              String(runRat.n),
              t.score.numerator,
              `Test score numerator mismatch on ${c.id} test ${t.name}`
            );
            assert.strictEqual(
              String(runRat.d),
              t.score.denominator,
              `Test score denominator mismatch on ${c.id} test ${t.name}`
            );
            assert.strictEqual(
              Number(run.score.toFixed(6)),
              Number(t.score.display.toFixed(6)),
              `Test score display mismatch on ${c.id} test ${t.name}`
            );
          }
        }

        assert.strictEqual(summary.status, c.expectedProblemVerdict, `Problem summary status mismatch on ${c.id}`);

        const testcaseTotalRat = testRuns.reduce(
          (total, run) => addRational(total, parseRational(run.scoreExact)),
          createRational(0),
        );
        if (testRuns.length > 0) assert.ok(summary.scoreExact, `Summary exact score is missing on ${c.id}`);
        const observedSummaryScoreRat = parseRational(summary.scoreExact ?? summary.score);
        assert.deepStrictEqual(observedSummaryScoreRat, testcaseTotalRat, `Summary exact score differs from awarded testcase total on ${c.id}`);
        assert.strictEqual(
          String(observedSummaryScoreRat.n),
          c.expectedScore.numerator,
          `Problem summary score numerator mismatch on ${c.id}`
        );
        assert.strictEqual(
          String(observedSummaryScoreRat.d),
          c.expectedScore.denominator,
          `Problem summary score denominator mismatch on ${c.id}`
        );
        assert.strictEqual(
          Number(summary.score.toFixed(6)),
          Number(c.expectedScore.display.toFixed(6)),
          `Problem summary score display mismatch on ${c.id}`
        );

        const observedMaxScoreRat = parseRational(summary.maxScoreExact ?? summary.maxScore);
        assert.strictEqual(
          String(observedMaxScoreRat.n),
          c.expectedMaxScore.numerator,
          `Problem summary maxScore numerator mismatch on ${c.id}`
        );
        assert.strictEqual(
          String(observedMaxScoreRat.d),
          c.expectedMaxScore.denominator,
          `Problem summary maxScore denominator mismatch on ${c.id}`
        );
        assert.strictEqual(
          Number(summary.maxScore.toFixed(6)),
          Number(c.expectedMaxScore.display.toFixed(6)),
          `Problem summary maxScore display mismatch on ${c.id}`
        );

        // Group effects validation against production
        if (c.groupEffects) {
          const polygonConfig = resolvedConfig.polygonConfig;
          const groupResults: Record<string, { allAccepted: boolean; tests: TestCaseRun[]; config: { dependencies?: string[]; policy?: string } }> = {};
          if (polygonConfig?.enableGroups && polygonConfig.groups) {
            for (const [groupName, groupConfig] of Object.entries(polygonConfig.groups)) {
              const tests = testRuns.filter((test) => polygonConfig.tests?.[test.name]?.group === groupName);
              groupResults[groupName] = {
                allAccepted: tests.length > 0 && tests.every((test) => test.status === "AC"),
                tests,
                config: groupConfig,
              };
            }
          }

          for (const ge of c.groupEffects) {
            const groupData = groupResults[ge.groupId];
            assert.ok(groupData, `Group ${ge.groupId} must exist in production polygonConfig for ${c.id}`);

            const dependenciesPassed = (groupData.config.dependencies || []).every(
              (dep) => !groupResults[dep] || groupResults[dep].allAccepted,
            );
            assert.strictEqual(
              dependenciesPassed,
              ge.dependenciesMet,
              `Group ${ge.groupId} dependenciesMet mismatch in ${c.id}`
            );

            let resolvedVerdict: string;
            if (groupData.tests.length === 0) {
              resolvedVerdict = "AC";
            } else if (groupData.allAccepted) {
              resolvedVerdict = "AC";
            } else {
              const failed = groupData.tests.filter((t) => t.status !== "AC");
              if (failed.length === groupData.tests.length && groupData.tests.every((t) => t.status === failed[0].status)) {
                resolvedVerdict = failed[0].status;
              } else {
                resolvedVerdict = "PARTIAL";
              }
            }
            assert.strictEqual(
              resolvedVerdict,
              ge.resolvedVerdict,
              `Group ${ge.groupId} resolvedVerdict mismatch in ${c.id}`
            );

            const groupScoreRat = groupData.tests.reduce(
              (total, run) => addRational(total, parseRational(run.scoreExact)),
              createRational(0),
            );
            assert.strictEqual(
              String(groupScoreRat.n),
              ge.score.numerator,
              `Group ${ge.groupId} score numerator mismatch in ${c.id}`
            );
            assert.strictEqual(
              String(groupScoreRat.d),
              ge.score.denominator,
              `Group ${ge.groupId} score denominator mismatch in ${c.id}`
            );
            assert.strictEqual(
              Number(rationalToNumber(groupScoreRat).toFixed(6)),
              Number(ge.score.display.toFixed(6)),
              `Group ${ge.groupId} score display mismatch in ${c.id}`
            );
          }
        }
        console.log(`[corpus-oracle] verified ${c.id}: ${summary.status}, ${testRuns.length} testcase results`);
      }
    } finally {
      await executorClient.shutdown();
      if (previousThemisAppData !== undefined) {
        process.env.THEMIS_APP_DATA_DIR = previousThemisAppData;
      } else {
        delete process.env.THEMIS_APP_DATA_DIR;
      }
      if (linkedToolchains) {
        try {
          fs.unlinkSync(targetToolchains);
        } catch {
          // Ignore
        }
      }
      const normalizedTemp = path.resolve(tempRoot);
      const normalizedOsTmp = path.resolve(os.tmpdir());
      assert.ok(normalizedTemp.startsWith(normalizedOsTmp), "Temp root must be within OS tmpdir");
      assert.ok(path.basename(normalizedTemp).startsWith("judgedesk-test-owned-"), "Temp root must have test-owned prefix");
      assert.ok(fs.existsSync(path.join(normalizedTemp, "judgedesk-test-owned")), "Marker file must be present");
      fs.rmSync(normalizedTemp, { recursive: true, force: true });
    }
  });

  it("invalid rational values and forged profiles fail", () => {
    // 1. Verify all manifest cases satisfy exact rational validation
    for (const c of manifest.cases) {
      assert.ok(RELEASE_PROFILE_EXTENSIONS.has(c.languageProfileId), `Forged languageProfileId: ${c.languageProfileId}`);
      assert.ok(isValidRational(c.expectedMaxScore), `Invalid expectedMaxScore in ${c.id}`);
      assert.ok(isValidRational(c.expectedScore), `Invalid expectedScore in ${c.id}`);
      for (const t of c.tests) {
        assert.ok(isValidRational(t.score), `Invalid score in test ${t.name} of ${c.id}`);
      }
      if (c.groupEffects) {
        for (const ge of c.groupEffects) {
          assert.ok(isValidRational(ge.score), `Invalid group score in ${c.id} group ${ge.groupId}`);
        }
      }
    }

    // 2. Safe-integer overflow precision mutant (LOG-0045-F2 probe)
    assert.strictEqual(
      isValidRational({ numerator: "9007199254740993", denominator: "1", display: 9007199254740992 }),
      false,
      "Mutant exceeding MAX_SAFE_INTEGER with rounded display must fail validation",
    );

    // 3. Exact safe-integer boundary (Number.MAX_SAFE_INTEGER)
    assert.strictEqual(
      isValidRational({ numerator: "9007199254740991", denominator: "1", display: 9007199254740991 }),
      true,
      "Exact Number.MAX_SAFE_INTEGER must pass validation",
    );

    // 4. Non-reduced fraction
    assert.strictEqual(
      isValidRational({ numerator: "2", denominator: "4", display: 0.5 }),
      false,
      "Unreduced fraction must fail validation",
    );

    // 5. Fraction-display disagreement
    assert.strictEqual(
      isValidRational({ numerator: "1", denominator: "2", display: 0.6 }),
      false,
      "Display disagreement must fail validation",
    );
  });

  it("unsafe or non-canonical paths fail", () => {
    for (const c of manifest.cases) {
      assert.ok(!c.fixtureRoot.startsWith("/"), `Absolute fixtureRoot in ${c.id}`);
      assert.ok(!c.fixtureRoot.includes(".."), `Directory traversal in fixtureRoot in ${c.id}`);
      for (const f of c.files) {
        assert.ok(!f.path.startsWith("/"), `Absolute path in file ${f.path} of ${c.id}`);
        assert.ok(!f.path.includes(".."), `Directory traversal in file ${f.path} of ${c.id}`);
        assert.ok(!f.path.includes("\\"), `Windows path separator in file ${f.path} of ${c.id}`);
      }
    }
  });

  it("descriptor security bounds and invariants fail-closed", () => {
    for (const c of manifest.cases) {
      const caseRoot = path.join(corpusRoot, c.fixtureRoot);
      const descriptorFile = c.files.find((f) => f.role === "descriptor");
      if (descriptorFile) {
        const fullPath = path.join(caseRoot, descriptorFile.path);
        assert.ok(fs.existsSync(fullPath), `Descriptor missing: ${fullPath}`);
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as {
          kind?: string;
          virtualFiles?: { path?: string; content?: string }[];
        };
        assert.strictEqual(
          parsed.kind,
          "case_collision_and_long_path",
          "Descriptor must declare kind case_collision_and_long_path"
        );
        assert.ok(Array.isArray(parsed.virtualFiles), "Descriptor must have virtualFiles array");
        assert.ok(parsed.virtualFiles.length > 0, "Descriptor cannot be empty");

        const vfiles = parsed.virtualFiles;

        // Invariant 1: Safe paths
        for (const vf of vfiles) {
          assert.ok(typeof vf.path === "string", "virtualFile path must be string");
          assert.ok(!path.isAbsolute(vf.path), `virtualFile absolute path forbidden: ${vf.path}`);
          assert.ok(!vf.path.startsWith("/"), `virtualFile absolute path forbidden: ${vf.path}`);
          assert.ok(!/^[a-zA-Z]:/.test(vf.path), `virtualFile Windows drive forbidden: ${vf.path}`);
          assert.ok(!vf.path.includes(".."), `virtualFile traversal forbidden: ${vf.path}`);
          assert.ok(!vf.path.includes("\\"), `virtualFile backslash forbidden: ${vf.path}`);
          const segments = vf.path.split("/");
          for (const seg of segments) {
            assert.ok(!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(seg), `virtualFile Windows device name forbidden: ${seg}`);
          }
        }

        // Invariant 2: Case collision invariant
        let hasCaseCollision = false;
        for (let i = 0; i < vfiles.length; ++i) {
          for (let j = i + 1; j < vfiles.length; ++j) {
            const p1 = vfiles[i].path;
            const p2 = vfiles[j].path;
            if (p1 && p2 && p1.toLowerCase() === p2.toLowerCase() && p1 !== p2) {
              hasCaseCollision = true;
              break;
            }
          }
          if (hasCaseCollision) break;
        }
        assert.ok(hasCaseCollision, "Descriptor must contain case-colliding paths (differing only by case)");

        // Invariant 3: Long path invariant (>= 200 characters)
        const hasLongPath = vfiles.some((vf) => (vf.path?.length ?? 0) >= 200);
        assert.ok(hasLongPath, "Descriptor must contain long path (>= 200 characters)");
      }
    }
  });

  it("all manifest files exist and match size/hash (or are explicitly expected absent/empty)", () => {
    for (const c of manifest.cases) {
      const caseRoot = path.join(corpusRoot, c.fixtureRoot);
      for (const f of c.files) {
        const fullPath = path.join(caseRoot, f.path);

        if (f.expectedAbsence) {
          assert.ok(!fs.existsSync(fullPath), `File ${fullPath} is expected to be absent but exists`);
          continue;
        }

        if (f.emptyDirectory) {
          assert.ok(fs.existsSync(fullPath), `Empty directory ${fullPath} does not exist`);
          const stat = fs.statSync(fullPath);
          assert.ok(stat.isDirectory(), `${fullPath} is not a directory`);
          const entries = fs.readdirSync(fullPath);
          assert.deepStrictEqual(entries, [".judgedesk-empty"], `Directory ${fullPath} contains testcase files or unexpected metadata`);
          continue;
        }

        assert.ok(fs.existsSync(fullPath), `File ${fullPath} is missing`);
        const stat = fs.statSync(fullPath);
        assert.ok(stat.isFile(), `${fullPath} is not a regular file`);
        assert.strictEqual(stat.size, f.size, `File size mismatch for ${fullPath}`);

        const buf = fs.readFileSync(fullPath);
        const hash = sha256(buf);
        assert.strictEqual(hash, f.sha256, `SHA256 mismatch for ${fullPath}`);
      }
    }
  });

  it("no undeclared corpus files exist", () => {
    for (const c of manifest.cases) {
      const caseRoot = path.join(corpusRoot, c.fixtureRoot);
      if (!fs.existsSync(caseRoot)) continue;

      const declaredPaths = new Set(c.files.map((f) => f.path));

      function walk(dir: string, base: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const relPath = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), relPath);
          } else {
            assert.ok(declaredPaths.has(relPath), `Undeclared file found: ${relPath} in ${caseRoot}`);
          }
        }
      }

      walk(caseRoot, "");
    }
  });

  it("missing required coverage fails (languages, verdicts, io, extensions, policies)", () => {
    const coveredLangs = new Set<string>();
    const coveredVerdicts = new Set<string>();
    const coveredIo = new Set<string>();
    const coveredExtensions = new Set<string>();
    let hasCustomChecker = false;
    let hasInteractor = false;
    let hasGroups = false;
    let hasDependencies = false;
    let hasCompleteGroup = false;
    let hasRational = false;
    let hasMalformedConfig = false;
    let hasUnicodeSpace = false;
    let hasTestlib = false;

    for (const c of manifest.cases) {
      for (const tag of c.tags) {
        for (const rLang of RELEASE_LANGUAGES) {
          if (tag === rLang) coveredLangs.add(rLang);
        }
      }
      coveredVerdicts.add(c.expectedProblemVerdict);
      coveredIo.add(c.ioMode);
      coveredExtensions.add(c.extension);

      if (c.tags.includes("custom_checker")) hasCustomChecker = true;
      if (c.tags.includes("interactor")) hasInteractor = true;
      if (c.tags.includes("groups")) hasGroups = true;
      if (c.tags.includes("dependencies")) hasDependencies = true;
      if (c.tags.includes("complete_group")) hasCompleteGroup = true;
      if (c.tags.includes("rational")) hasRational = true;
      if (c.tags.includes("testlib")) hasTestlib = true;
      if (c.id === "malformed_config") hasMalformedConfig = true;
      if (c.id === "unicode_space_paths") hasUnicodeSpace = true;
    }

    for (const lang of RELEASE_LANGUAGES) {
      assert.ok(coveredLangs.has(lang), `Missing coverage for language: ${lang}`);
    }

    for (const v of VERDICTS) {
      assert.ok(coveredVerdicts.has(v), `Missing coverage for verdict: ${v}`);
    }

    assert.ok(coveredIo.has("stdio"), "Missing stdio I/O coverage");
    assert.ok(coveredIo.has("file"), "Missing file I/O coverage");
    assert.ok(coveredExtensions.has("pp"), "Missing real Pascal .pp extension coverage");
    assert.ok(coveredExtensions.has("sb"), "Missing real Scratch .sb extension coverage");
    assert.ok(hasCustomChecker, "Missing custom checker coverage");
    assert.ok(hasInteractor, "Missing interactor coverage");
    assert.ok(hasGroups, "Missing groups coverage");
    assert.ok(hasDependencies, "Missing group dependencies coverage");
    assert.ok(hasCompleteGroup, "Missing COMPLETE_GROUP policy coverage");
    assert.ok(hasRational, "Missing non-integral rational boundary coverage");
    assert.ok(hasTestlib, "Missing testlib exit matrix coverage");
    assert.ok(hasMalformedConfig, "Missing malformed config coverage");
    assert.ok(hasUnicodeSpace, "Missing Unicode and spaces filename coverage");

    let hasPathology = false;
    for (const c of manifest.cases) {
      if (c.tags.includes("pathology")) hasPathology = true;
    }
    assert.ok(hasPathology, "Missing pathology coverage (empty dir, long path, case collision)");
  });
});
