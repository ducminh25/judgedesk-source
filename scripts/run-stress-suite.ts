import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type {
  HostStatus,
  JudgeStreamEvent,
  ProblemResult,
  TestVerdict,
} from "../shared/contracts.js";

interface ExpectationDocument {
  schemaVersion: number;
  cases: ExpectationCase[];
  exploratorySecurityCases: ExpectationCase[];
}

interface ExpectationCase {
  contestant: string;
  problem: string;
  expected?: string;
  expectedTests?: Record<string, TestVerdict>;
  applicablePlatforms?: NodeJS.Platform[];
  requiredCapabilities?: string[];
  dangerous?: boolean;
  securityAssertion?: string;
  forbiddenOutputContains?: string;
}

interface NormalizedExpectation {
  source: ExpectationCase;
  compileStatus: ProblemResult["compileStatus"];
  summaryVerdict?: TestVerdict;
  everyTestVerdict?: TestVerdict;
  orderedTestVerdicts?: TestVerdict[];
  expectedTests?: Record<string, TestVerdict>;
  testCount?: number;
  score?: number;
  maxScore?: number;
}

const stressRoot = process.env.STRESS_TEST_ROOT || "d:/Minh/Code/stress_test_judge";
const serverPort = Number(process.env.PORT || "3003");
const serverUrl = `http://127.0.0.1:${serverPort}`;

if (!fs.existsSync(stressRoot)) {
  throw new Error(`Stress root directory does not exist: ${stressRoot}`);
}

const expectationsPath = path.join(stressRoot, "EXPECTED_RESULTS.json");
const document = JSON.parse(fs.readFileSync(expectationsPath, "utf8")) as ExpectationDocument;
assert.equal(document.schemaVersion, 2, "Stress expectations must use schemaVersion 2");

const includeSecurity = process.env.STRESS_INCLUDE_SECURITY === "true";
const requestedCases = new Set(
  (process.env.STRESS_CASES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

// Start server in-process
process.env.PORT = String(serverPort);
process.env.NODE_ENV = "production";

console.log("[Stress Runner] Booting in-process JudgeDesk server...");
await import("../server.ts");

// Wait for server ready
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${serverUrl}/api/status`);
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const hostStatus = await fetchJson<HostStatus>(`${serverUrl}/api/status`);
console.log("[Stress Runner] Host Status:", {
  cpp: hostStatus.gpp.version + " (" + hostStatus.gpp.source + ")",
  python: hostStatus.python.version + " (" + hostStatus.python.source + ")",
  secureRunner: hostStatus.secureRunner.mode + " v" + hostStatus.secureRunner.executorVersion,
});

const candidates = [
  ...document.cases,
  ...(includeSecurity ? document.exploratorySecurityCases : []),
].filter((item) => {
  if (item.applicablePlatforms && !item.applicablePlatforms.includes(process.platform)) return false;
  if (requestedCases.size === 0) return true;
  return requestedCases.has(`${item.contestant}/${item.problem}`.toLowerCase());
});

console.log(`[Stress Runner] Running ${candidates.length} test cases...\n`);

let passCount = 0;
let skipCount = 0;
let failCount = 0;

const toolchainsResponse = await fetchJson<any>(`${serverUrl}/api/toolchains/v2`).catch(() => null);
const readyLanguages = new Set<string>();
if (hostStatus.gpp?.submissionReady) {
  readyLanguages.add("cpp");
  readyLanguages.add("c");
}
if (hostStatus.python?.submissionReady) {
  readyLanguages.add("python");
}
if (toolchainsResponse?.profiles) {
  for (const [profId, profState] of Object.entries(toolchainsResponse.profiles as Record<string, any>)) {
    if (profState?.status === "ready" || profState?.activeToolchain) {
      readyLanguages.add(profId);
    }
  }
}

for (const item of candidates) {
  const ext = submissionExtension(item.contestant, item.problem);
  const lang = ext === ".cpp" ? "cpp" : ext === ".c" ? "c" : ext === ".py" ? "python" : ext === ".pas" ? "pascal" : ext === ".java" ? "java" : null;

  if (lang && !readyLanguages.has(lang)) {
    const requiresInstalledToolchain = item.requiredCapabilities?.some(cap => cap.startsWith("managed-")) || (item.expected !== "CE" && (ext === ".pas" || ext === ".java"));
    if (requiresInstalledToolchain) {
      console.log(`- SKIP [${passCount + skipCount + 1}/${candidates.length}] ${item.contestant}/${item.problem}: requires ${lang} toolchain`);
      skipCount++;
      continue;
    }
  }

  try {
    const expectation = normalizeExpectation(item);
    const result = await judge(expectation.source);
    assertResult(result, expectation);
    passCount++;
    console.log(
      `✔ PASS [${passCount}/${candidates.length}] ${item.contestant}/${item.problem}: `
      + `${result.compileStatus}, ${result.summary.status}, `
      + `Score: ${result.summary.score}/${result.summary.maxScore}`
    );
  } catch (err: any) {
    failCount++;
    console.error(`✖ FAIL ${item.contestant}/${item.problem}: ${err.message}`);
  }
}

console.log(`\n========================================`);
console.log(`STRESS SUITE RESULT: ${passCount} PASSED, ${failCount} FAILED, ${skipCount} SKIPPED / ${candidates.length} TOTAL`);
console.log(`========================================`);

try {
  const { executorClient } = await import("../server/executor/client.js");
  await executorClient.shutdown();
} catch {}

process.exit(failCount > 0 ? 1 : 0);

function submissionExtension(contestant: string, problem: string): string | null {
  const contestantDirectory = path.join(stressRoot, "contestants", contestant);
  for (const extension of [".cpp", ".py", ".c", ".pas", ".java"]) {
    if (fs.existsSync(path.join(contestantDirectory, `${problem}${extension}`))) return extension;
  }
  return null;
}

async function judge(expectation: ExpectationCase): Promise<ProblemResult> {
  const response = await fetch(`${serverUrl}/api/batch-judge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thisinhPath: path.join(stressRoot, "contestants"),
      testPath: path.join(stressRoot, "test"),
      jobId: `stress_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      problemConfigs: {},
      targetContestants: [expectation.contestant],
      targetProblems: [expectation.problem],
    }),
  });
  if (!response.ok) {
    throw new Error(`Judge returned HTTP ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  const events = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgeStreamEvent);
  const error = events.find((event) => event.type === "error");
  if (error?.type === "error") throw new Error(error.data.message);
  const completed = events.find((event) => event.type === "problem_completed");
  assert.ok(
    completed?.type === "problem_completed",
    `No result for ${expectation.contestant}/${expectation.problem}`,
  );
  return completed.data.problemResult;
}

function assertResult(
  result: ProblemResult,
  expectation: NormalizedExpectation,
): void {
  const label = `${expectation.source.contestant}/${expectation.source.problem}`;
  assert.equal(result.compileStatus, expectation.compileStatus, `${label} compile status`);
  if (expectation.summaryVerdict) {
    assert.equal(result.summary.status, expectation.summaryVerdict, `${label} summary verdict`);
  }
  if (expectation.testCount !== undefined) {
    assert.equal(result.testCases.length, expectation.testCount, `${label} test count`);
  }
  if (expectation.everyTestVerdict) {
    for (const test of result.testCases) {
      assert.equal(test.status, expectation.everyTestVerdict, `${label}/${test.name} verdict`);
    }
  }
  if (expectation.orderedTestVerdicts) {
    assert.deepEqual(
      result.testCases.map((test) => test.status),
      expectation.orderedTestVerdicts,
      `${label} ordered verdicts`,
    );
  }
  for (const [testName, verdict] of Object.entries(expectation.expectedTests || {})) {
    const test = result.testCases.find((item) => item.name === testName);
    assert.ok(test, `${label}/${testName} result is missing`);
    assert.equal(test.status, verdict, `${label}/${testName} verdict`);
  }
  if (expectation.score !== undefined) {
    assert.equal(result.summary.score, expectation.score, `${label} score`);
  }
  if (expectation.maxScore !== undefined) {
    assert.equal(result.summary.maxScore, expectation.maxScore, `${label} max score`);
  }
  if (expectation.source.forbiddenOutputContains) {
    const marker = expectation.source.forbiddenOutputContains;
    for (const test of result.testCases) {
      assert.ok(
        !test.actualOutputPreview?.includes(marker),
        `${label}/${test.name} emitted forbidden security marker ${JSON.stringify(marker)}`,
      );
    }
  }
}

function normalizeExpectation(source: ExpectationCase): NormalizedExpectation {
  if (source.expectedTests) {
    return {
      source,
      compileStatus: "OK",
      expectedTests: source.expectedTests,
    };
  }
  const value = source.expected || "";
  if (value === "CE") {
    return { source, compileStatus: "CE", summaryVerdict: "CE", score: 0 };
  }

  const explicitScore = value.match(/\bscore\s+([0-9.]+)/i);
  const counted = value.match(/^([A-Z]+):(\d+)\/(\d+)/);
  const ordered = value.match(/^tests\s+([A-Z,\s]+);/i);
  const summary = value.match(/^([A-Z]+)/)?.[1] as TestVerdict | undefined;
  const score = explicitScore
    ? Number(explicitScore[1])
    : counted && counted[1] === "AC"
      ? Number(counted[2])
      : counted
        ? 0
        : undefined;
  return {
    source,
    compileStatus: "OK",
    summaryVerdict: summary,
    everyTestVerdict: counted ? counted[1] as TestVerdict : undefined,
    orderedTestVerdicts: ordered
      ? ordered[1].split(",").map((item) => item.trim() as TestVerdict)
      : undefined,
    testCount: counted ? Number(counted[3]) : undefined,
    score,
    maxScore: counted
      ? explicitScore && counted[1] === "AC"
        ? Number(explicitScore[1])
        : Number(counted[3])
      : undefined,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return await response.json() as T;
}
