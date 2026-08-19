import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

interface Sample {
  stagingMs: number;
  executorDispatchMs: number;
  securitySetupMs: number;
  dispatchAndSecurityMs: number;
  executionMs: number;
  resultCollectionMs: number;
  cleanupMs: number;
  endToEndMs: number;
}

const MiB = 1024 * 1024;
const iterations = integerOption("--iterations", 1000);
const suites = integerOption("--suites", 5);
const warmups = integerOption("--warmups", 20);
const enforce = process.argv.includes("--enforce");
const outputDirectory = path.resolve(option("--output", "docs/benchmarks"));
const toolchainReadinessTimeoutMs = 15_000;
const ownedMacosTreeGuard = provisionMacosTreeGuard();
const [
  { executorClient },
  { DEFAULT_EXECUTOR_LIMITS },
  { createExecutorWorkspace },
  { compileSubmission, resolveCompilationToolchain },
] = await Promise.all([
  import("../server/executor/client.js"),
  import("../server/executor/protocol.js"),
  import("../server/executor/workspace.js"),
  import("../server/judge/compiler.js"),
] as const).catch((error) => {
  releaseMacosTreeGuard(ownedMacosTreeGuard);
  throw error;
});
let temporaryDirectory: string;
try {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-executor-benchmark-"));
} catch (error) {
  releaseMacosTreeGuard(ownedMacosTreeGuard);
  throw error;
}

try {
  const health = await executorClient.start();
  if (!health.ready) throw new Error(health.diagnostics.join("; ") || "SECURE_RUNNER_UNAVAILABLE");
  const sourcePath = path.join(temporaryDirectory, "noop.cpp");
  fs.writeFileSync(sourcePath, "int main() { return 0; }\n", "utf8");
  // Use the same native-protection selection as production judging. On Windows an
  // already verified executor cache remains usable even if the original installer
  // directory was moved or removed.
  const benchmarkToolchain = await resolveBenchmarkToolchain();
  if (!benchmarkToolchain.ready) {
    throw new Error(benchmarkToolchain.diagnostic || "A benchmark-compatible C++ toolchain is unavailable.");
  }
  const compilation = await compileSubmission({
    language: "cpp",
    contestantName: "benchmark",
    problemName: "noop",
    submissionPath: sourcePath,
    tempDirectory: temporaryDirectory,
    cppToolchain: benchmarkToolchain,
  });
  if (compilation.compileStatus !== "OK") throw new Error(`Benchmark compilation failed: ${compilation.compileError}`);

  for (let index = 0; index < warmups; index += 1) await measure(compilation.executablePath);
  const rssBefore = process.memoryUsage().rss;
  const suiteReports = [];
  const allSamples: Sample[] = [];
  for (let suite = 0; suite < suites; suite += 1) {
    const samples: Sample[] = [];
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) samples.push(await measure(compilation.executablePath));
    const durationMs = performance.now() - started;
    allSamples.push(...samples);
    suiteReports.push({
      suite: suite + 1,
      iterations,
      durationMs,
      throughputPerSecond: iterations / (durationMs / 1000),
      stats: summarize(samples),
    });
    console.log(`suite ${suite + 1}/${suites}: ${iterations} tests in ${durationMs.toFixed(1)} ms`);
  }
  const rssAfter = process.memoryUsage().rss;
  const aggregate = summarize(allSamples);
  const memoryGrowthBytes = Math.max(0, rssAfter - rssBefore);
  // IPC dispatch and OS sandbox creation are independent stages. The old gate
  // compared their sum against the IPC-only 5/10 ms budget, so the committed
  // v1.2.4 Windows baseline failed by construction even though IPC was ~2 ms.
  // macOS dispatch also includes the authenticated guardian/supervisor handoff;
  // the v1.3.0 M1 baseline is about 11/13 ms before sandbox setup. Keep the
  // stricter Windows IPC budget and bound the full macOS handoff separately.
  const dispatchP50Limit = process.platform === "darwin" ? 15 : 5;
  const dispatchP95Limit = process.platform === "darwin" ? 20 : 10;
  const securitySetupP50Limit = process.platform === "darwin" ? 8 : 15;
  const securitySetupP95Limit = process.platform === "darwin" ? 15 : 25;
  const gates = {
    dispatchP50Ms: {
      limit: dispatchP50Limit,
      actual: aggregate.executorDispatchMs.p50,
      pass: aggregate.executorDispatchMs.p50 <= dispatchP50Limit,
    },
    dispatchP95Ms: {
      limit: dispatchP95Limit,
      actual: aggregate.executorDispatchMs.p95,
      pass: aggregate.executorDispatchMs.p95 <= dispatchP95Limit,
    },
    securitySetupP50Ms: {
      limit: securitySetupP50Limit,
      actual: aggregate.securitySetupMs.p50,
      pass: aggregate.securitySetupMs.p50 <= securitySetupP50Limit,
    },
    securitySetupP95Ms: {
      limit: securitySetupP95Limit,
      actual: aggregate.securitySetupMs.p95,
      pass: aggregate.securitySetupMs.p95 <= securitySetupP95Limit,
    },
    backendMemoryGrowthMiB: {
      limit: 100,
      actual: memoryGrowthBytes / MiB,
      pass: memoryGrowthBytes <= 100 * MiB,
    },
  };
  const toolchain = benchmarkToolchain;
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runner: health,
    machine: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      osVersion: os.version(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      toolchain: toolchain.ready
        ? { version: toolchain.version, source: toolchain.source }
        : { error: toolchain.diagnostic || "unavailable" },
    },
    workload: { name: "C++ no-op", warmups, iterationsPerSuite: iterations, suites },
    compilationMs: compilation.compileTime,
    aggregate,
    suiteReports,
    memoryGrowthBytes,
    gates,
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  const stem = `executor-${process.platform}-${process.arch}`;
  const jsonPath = path.join(outputDirectory, `${stem}.json`);
  const markdownPath = path.join(outputDirectory, `${stem}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown(report), "utf8");
  console.log(`Benchmark JSON: ${jsonPath}`);
  console.log(`Benchmark report: ${markdownPath}`);
  console.log(JSON.stringify(gates, null, 2));
  if (enforce && Object.values(gates).some((gate) => !gate.pass)) process.exitCode = 1;
} finally {
  try {
    await executorClient.shutdown();
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    releaseMacosTreeGuard(ownedMacosTreeGuard);
  }
}

async function resolveBenchmarkToolchain(): Promise<Awaited<ReturnType<typeof resolveCompilationToolchain>>> {
  const deadline = Date.now() + toolchainReadinessTimeoutMs;
  let toolchain = await resolveCompilationToolchain("cpp");
  while (
    !toolchain.ready
    && toolchain.diagnosticCode === "DETECTION_IN_PROGRESS"
    && Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    toolchain = await resolveCompilationToolchain("cpp");
  }
  return toolchain;
}

interface OwnedMacosTreeGuard {
  directory: string;
}

function provisionMacosTreeGuard(): OwnedMacosTreeGuard | null {
  if (process.platform !== "darwin") return null;
  const keys = [
    "JUDGEDESK_TREE_GUARD_REQUIRED",
    "JUDGEDESK_TREE_GUARD_PATH",
    "JUDGEDESK_TREE_GUARD_GENERATION",
  ] as const;
  const present = keys.filter((key) => process.env[key] !== undefined);
  if (present.length === keys.length) {
    if (process.env.JUDGEDESK_TREE_GUARD_REQUIRED !== "1") {
      throw new Error("invalid macOS process-tree guard requirement");
    }
    return null;
  }
  if (present.length !== 0) {
    throw new Error(`partial macOS process-tree guard environment: ${present.join(", ")}`);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-benchmark-tree-guard-"));
  try {
    fs.chmodSync(directory, 0o700);
    const generation = crypto.randomBytes(32).toString("hex");
    const guardPath = path.join(directory, "process-tree.generation");
    fs.writeFileSync(
      guardPath,
      `JUDGEDESK_PROCESS_TREE/1\ngeneration=${generation}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    fs.chmodSync(guardPath, 0o600);
    process.env.JUDGEDESK_TREE_GUARD_REQUIRED = "1";
    process.env.JUDGEDESK_TREE_GUARD_PATH = guardPath;
    process.env.JUDGEDESK_TREE_GUARD_GENERATION = generation;
    return { directory };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function releaseMacosTreeGuard(owned: OwnedMacosTreeGuard | null): void {
  if (!owned) return;
  delete process.env.JUDGEDESK_TREE_GUARD_REQUIRED;
  delete process.env.JUDGEDESK_TREE_GUARD_PATH;
  delete process.env.JUDGEDESK_TREE_GUARD_GENERATION;
  fs.rmSync(owned.directory, { recursive: true, force: true });
}

async function measure(binaryPath: string): Promise<Sample> {
  const endToEndStarted = performance.now();
  const stagingStarted = performance.now();
  const workspace = await createExecutorWorkspace();
  const exeName = process.platform === "win32" ? "submission.exe" : "submission";
  workspace.stage(binaryPath, exeName, true);
  const executableId = workspace.relative(exeName);
  const stagingMs = performance.now() - stagingStarted;
  try {
    const dispatchStarted = performance.now();
    const result = await executorClient.run({
      runId: `benchmark_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: workspace.id,
      executableId,
      args: [],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.submission,
        wallTimeMs: 2000,
        memoryBytes: 128 * MiB,
      },
    });
    const dispatchRoundTripMs = performance.now() - dispatchStarted;
    if (result.reason !== "exited" || result.exitCode !== 0) throw new Error(`No-op failed: ${JSON.stringify(result)}`);
    const securitySetupMs = result.securitySetupTimeUs / 1000;
    const executionMs = result.wallTimeUs / 1000;
    const resultCollectionMs = result.resultCollectionTimeUs / 1000;
    const executorDispatchMs = Math.max(
      0,
      dispatchRoundTripMs - securitySetupMs - executionMs - resultCollectionMs,
    );
    const cleanupStarted = performance.now();
    workspace.dispose();
    const cleanupMs = performance.now() - cleanupStarted;
    return {
      stagingMs,
      executorDispatchMs,
      securitySetupMs,
      dispatchAndSecurityMs: executorDispatchMs + securitySetupMs,
      executionMs,
      resultCollectionMs,
      cleanupMs,
      endToEndMs: performance.now() - endToEndStarted,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

function summarize(samples: Sample[]) {
  return Object.fromEntries(
    ([
      "stagingMs",
      "executorDispatchMs",
      "securitySetupMs",
      "dispatchAndSecurityMs",
      "executionMs",
      "resultCollectionMs",
      "cleanupMs",
      "endToEndMs",
    ] as const).map((key) => {
      const values = samples.map((sample) => sample[key]).sort((left, right) => left - right);
      return [key, {
        median: percentile(values, 0.5),
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        min: values[0] ?? 0,
        max: values.at(-1) ?? 0,
      }];
    }),
  );
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function integerOption(name: string, fallback: number): number {
  const value = Number.parseInt(option(name, String(fallback)), 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function markdown(report: any): string {
  const stats = report.aggregate;
  const gateRows = Object.entries(report.gates).map(([name, gate]: [string, any]) =>
    `| ${name} | ${gate.actual.toFixed(3)} | ${gate.limit} | ${gate.pass ? "PASS" : "FAIL"} |`,
  ).join("\n");
  return `# Native executor benchmark (${report.machine.platform}/${report.machine.architecture})

- Generated: ${report.generatedAt}
- CPU: ${report.machine.cpu} (${report.machine.logicalCpus} logical CPUs)
- OS: ${report.machine.osVersion}
- Runner: ${report.runner.mode} ${report.runner.executorVersion}
- Workload: ${report.workload.suites} × ${report.workload.iterationsPerSuite} C++ no-op tests after ${report.workload.warmups} warmups

| Stage | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Staging | ${stats.stagingMs.p50.toFixed(3)} | ${stats.stagingMs.p95.toFixed(3)} |
| Executor dispatch/IPC | ${stats.executorDispatchMs.p50.toFixed(3)} | ${stats.executorDispatchMs.p95.toFixed(3)} |
| OS sandbox setup | ${stats.securitySetupMs.p50.toFixed(3)} | ${stats.securitySetupMs.p95.toFixed(3)} |
| Dispatch + security setup | ${stats.dispatchAndSecurityMs.p50.toFixed(3)} | ${stats.dispatchAndSecurityMs.p95.toFixed(3)} |
| Execution | ${stats.executionMs.p50.toFixed(3)} | ${stats.executionMs.p95.toFixed(3)} |
| Result collection | ${stats.resultCollectionMs.p50.toFixed(3)} | ${stats.resultCollectionMs.p95.toFixed(3)} |
| Cleanup | ${stats.cleanupMs.p50.toFixed(3)} | ${stats.cleanupMs.p95.toFixed(3)} |
| End-to-end | ${stats.endToEndMs.p50.toFixed(3)} | ${stats.endToEndMs.p95.toFixed(3)} |

| Gate | Actual | Limit | Result |
|---|---:|---:|---|
${gateRows}

Backend RSS growth: ${(report.memoryGrowthBytes / MiB).toFixed(2)} MiB.
`;
}
