import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ResolvedToolchain } from "../toolchains/types.js";
import type { NormalizedProblemConfig } from "../types.js";
import type { ExecutorInteractiveRunResult } from "../executor/protocol.js";
// Register the imported guardian gate at module scope, outside this worker's
// test context. The launch name pattern excludes that separate top-level gate.
// This harness imports no production singleton; the parent already set env.
import { readTraceEvents, requireIdentity, assertKernelIdentity,
  assertGroupEmpty, waitForGenerationExclusive, waitForProcessGone }
  from "./macos-run-guardian.integration.test.js";

// No production value imports precede these isolation checks. The parent sets
// Node TMPDIR/AppData before this process starts, rather than only isolating E.
const runRoot = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_RUN_ROOT;
assert.ok(runRoot, "worker must be launched by the private production gate");
assert.equal(fs.realpathSync(runRoot), runRoot);
assert.equal(fs.realpathSync(os.tmpdir()), path.join(runRoot, "tmp"));
assert.ok(process.env.THEMIS_APP_DATA_DIR);
assert.ok(process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR);
const eventLog = process.env.JUDGEDESK_RUN_GUARDIAN_EVENT_LOG;
const generation = process.env.JUDGEDESK_TREE_GUARD_GENERATION;
const generationPath = process.env.JUDGEDESK_TREE_GUARD_PATH;
assert.ok(eventLog && generation && generationPath);

type Role = "cpp" | "python";
type Language = "cpp" | "c" | "python" | "pascal" | "java" | "scratch";
const languages: readonly Language[] = ["cpp", "c", "python", "pascal", "java", "scratch"];
type CaseGroup = "baseline" | "local-python" | "verdicts" | "refusals";
const selectedCases = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_CASES;
assert.ok(selectedCases === undefined || ["baseline", "local-python", "verdicts", "refusals"].includes(selectedCases),
  "invalid production matrix case selection");
interface OutcomeRow {
  name: string;
  exit: number;
  message?: string;
  transcript?: string;
  maximum?: string;
  exact: string;
  status: "AC" | "WA" | "PE" | "PARTIAL" | "JE" | "RE" | "TLE" | "MLE" | "OLE";
  actor?: "exit1" | "sleep" | "memory" | "output" | "write" | "files" | "peer-hold";
  checkerActor?: "output" | "write" | "files";
  checkerSleep?: boolean;
  display?: number;
}
const outcomeRows: readonly OutcomeRow[] = [
  { name: "AC exact maximum", exit: 0, maximum: "9007199254740991/3", exact: "9007199254740991/3", status: "AC" },
  { name: "WA", exit: 1, exact: "0", status: "WA" },
  { name: "PE", exit: 2, exact: "0", status: "PE" },
  { name: "checker JE", exit: 3, exact: "0", status: "JE" },
  { name: "lexical result decimal", exit: 7, message: "result=.1", maximum: "1/3", exact: "1/30", status: "PARTIAL", display: 0.03 },
  { name: "lexical score decimal", exit: 7, message: "score: 0.25", maximum: "1/3", exact: "1/12", status: "PARTIAL", display: 0.08 },
  { name: "absolute points", exit: 7, message: "points 2.5", maximum: "10", exact: "5/2", status: "PARTIAL", display: 2.5 },
  { name: "last transcript decimal", exit: 7, transcript: "receipt\n.75\n", maximum: "1/3", exact: "1/4", status: "PARTIAL", display: 0.25 },
  { name: "numeric metadata precedence", exit: 66, message: "score: 0.25", maximum: "1/3", exact: "1/6", status: "PARTIAL", display: 0.17 },
  { name: "large exact lexical award", exit: 7, message: "points 0.5", maximum: "9007199254740991/3", exact: "9007199254740991/6", status: "PARTIAL" },
  { name: "missing carrier retains partial zero", exit: 7, exact: "0", status: "PARTIAL" },
  { name: "negative carrier retains partial zero", exit: 7, message: "score: -0.1", exact: "0", status: "PARTIAL" },
  { name: "invalid decimal retains partial zero", exit: 7, message: "result=0.1.2", exact: "0", status: "PARTIAL" },
  { name: "message exponent prefix preserves lexical oracle", exit: 7, message: "result=1e-1", maximum: "1/3", exact: "1/3", status: "PARTIAL" },
  { name: "message fraction prefix preserves lexical oracle", exit: 7, message: "result=1/3", maximum: "1/3", exact: "1/3", status: "PARTIAL" },
  { name: "transcript exponent is not a decimal", exit: 7, transcript: "1e-1\n", exact: "0", status: "PARTIAL" },
  { name: "over maximum is JE", exit: 7, message: "points 11", maximum: "10", exact: "0", status: "JE" },
  { name: "submission nonzero canonical RE", exit: 9, actor: "exit1", exact: "0", status: "RE" },
  { name: "submission wall timeout", exit: 0, actor: "sleep", exact: "0", status: "TLE" },
  { name: "submission memory limit", exit: 0, actor: "memory", exact: "0", status: "MLE" },
  { name: "checker wall timeout is JE", exit: 0, checkerSleep: true, exact: "0", status: "JE" },
  { name: "submission output quota", exit: 0, actor: "output", exact: "0", status: "OLE" },
  { name: "submission aggregate write quota", exit: 0, actor: "write", exact: "0", status: "OLE" },
  { name: "submission created-file quota", exit: 0, actor: "files", exact: "0", status: "OLE" },
  { name: "submission write quota rejects emitted checker partial-score text", exit: 7, message: "points 1", actor: "write", exact: "0", status: "OLE" },
  { name: "checker output quota is JE", exit: 0, actor: "peer-hold", checkerActor: "output", exact: "0", status: "JE" },
  { name: "checker aggregate write quota is JE", exit: 0, actor: "peer-hold", checkerActor: "write", exact: "0", status: "JE" },
  { name: "checker created-file quota is JE", exit: 0, actor: "peer-hold", checkerActor: "files", exact: "0", status: "JE" },
];

for (const listener of process.listeners("SIGTERM")) {
  process.off("SIGTERM", listener);
}

test("macOS production interactive worker", { timeout: 840_000 }, async (t) => {
  for (const listener of process.listeners("SIGTERM")) {
    process.off("SIGTERM", listener);
  }
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const completedRows: string[] = [];
  let stopping: Promise<void> | undefined;
  let admissionClosed = false;
  const runCase = async (group: CaseGroup, name: string, operation: () => void | Promise<void>) => {
    if (admissionClosed) return;
    if (selectedCases === undefined || selectedCases === group) await t.test(name, async () => {
      if (admissionClosed) return;
      try {
        await operation();
      } catch (error) {
        if (admissionClosed) return;
        throw error;
      }
      if (!admissionClosed) {
        completedRows.push(name);
      }
    });
  };
  const { executorClient } = await import("../executor/client.js");
  const { cancelAllActiveJudgeJobs, tryRegisterJudgeJob } = await import("../jobs.js");
  // Observe the real framed response without substituting a test result. This
  // distinguishes quota JE from a timeout/crash that would also produce JE.
  const realInteractive = executorClient.runInteractive.bind(executorClient);
  let lastNativeResult: ExecutorInteractiveRunResult | undefined;
  executorClient.runInteractive = async (...args) => {
    const result = await realInteractive(...args);
    lastNativeResult = result;
    return result;
  };
  const { compileSubmission } = await import("../judge/compiler.js");
  const { resolveInteractor } = await import("../judge/interactor-compiler.js");
  const { runTestCase } = await import("../judge/testcase-runner.js");
  const { resolveManagedToolchain, verifyLocalToolchainCandidate } = await import("../toolchains/resolver.js");
  const { scheduleLocalCompatibilityProbe, deriveLocalToolchain } = await import("../toolchains/local-execution.js");
  const { getRegisteredProfileForKind } = await import("../languages/registry.js");
  const { createCompileConfig } = await import("../../shared/compile-config.js");
  const { parseRational, rationalToNumber } = await import("../../shared/rational.js");
  const stop = () => stopping ??= executorClient.shutdown();
  const terminate = () => {
    admissionClosed = true;
    cancelAllActiveJudgeJobs();
    void stop().catch((error: unknown) => { console.error(error); });
  };
  process.on("SIGTERM", terminate);
  t.signal.addEventListener("abort", terminate, { once: true });
  t.after(async () => {
    try {
      await stop();
      await executorClient.waitForStdioClose();
      await waitForGenerationExclusive(generationPath, 10_000);
    } finally {
      executorClient.runInteractive = realInteractive;
      process.off("SIGTERM", terminate);
      t.signal.removeEventListener("abort", terminate);
    }
  });
  const health = await executorClient.start();
  assert.equal(health.ready, true, JSON.stringify(health));
  assert.equal(health.mode, "macos-seatbelt-native");
  assert.equal(health.networkBlocked, true);
  assert.equal(health.filesystemIsolated, true);
  assert.equal(health.processTreeControlled, true);
  assert.equal(fs.realpathSync(health.executorRoot), path.join(os.tmpdir(), "JudgeDeskExecutor"),
    `executor root escaped private TMPDIR: ${health.executorRoot}`);
  const root = path.join(runRoot, "cases");
  fs.mkdirSync(root, { mode: 0o700 });
  const ready = readTraceEvents(eventLog).find((event) => event.event === "fault_gate_ready");
  assert.ok(ready, "actual production executor must expose the existing private trace");
  assert.equal(ready.generation, generation);
  // fault_gate_ready deliberately has no process identity. Independently query
  // the one exact executor command with this worker as its kernel parent.
  const binary = fs.realpathSync(process.env.JUDGEDESK_EXECUTOR_PATH ?? path.join(process.cwd(),
    "src-tauri", "binaries", "judgedesk-executor-aarch64-apple-darwin"));
  const executorRows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => match !== null && Number(match[2]) === process.pid && match[3] === binary);
  assert.equal(executorRows.length, 1, "expected one exact executor child command");
  const executorPid = Number(executorRows[0]?.[1]);
  const identityValue: unknown = JSON.parse(execFileSync(binary, ["--test-process-identity", String(executorPid)], { encoding: "utf8" }));
  assert.ok(typeof identityValue === "object" && identityValue !== null);
  const identityRecord = identityValue as Record<string, unknown>;
  assert.equal(identityRecord.pid, executorPid);
  assert.ok(Number.isSafeInteger(identityRecord.pgid) && Number(identityRecord.pgid) > 1);
  assert.match(String(identityRecord.startAbstime), /^[1-9][0-9]*$/);
  const executorIdentity = { pid: executorPid, pgid: Number(identityRecord.pgid), startAbstime: String(identityRecord.startAbstime) };
  assertKernelIdentity(executorIdentity);
  t.diagnostic(JSON.stringify({ generation, executorIdentity, executorRoot: health.executorRoot, selectedCases: selectedCases ?? "all" }));

  const assertDrained = async (startLine: number, requirePair: boolean) => {
    const events = readTraceEvents(eventLog).filter((event) => event.lineIndex >= startLine);
    for (const event of events) assert.equal(event.generation, generation);
    const enrolled = events.filter((event) => event.event === "supervisor_registered");
    if (requirePair) assert.equal(enrolled.length, 2, `expected both real participant enrollments: ${JSON.stringify(events)}`);
    for (const registered of enrolled) {
      const anchor = requireIdentity(registered, "anchor");
      const guardian = requireIdentity(registered, "guardian");
      await assertGroupEmpty(anchor.pgid);
      await waitForProcessGone(guardian.pid, 5_000);
      const terminal = readTraceEvents(eventLog);
      assert.ok(terminal.some((event) => event.runId === registered.runId && event.event === "group_drained"), registered.runId);
      assert.ok(terminal.some((event) => event.runId === registered.runId && event.event === "guardian_cleaned"), registered.runId);
      const profiles = path.join(health.executorRoot, "profiles");
      assert.deepEqual(fs.readdirSync(profiles).filter((name) => name.startsWith(`${registered.runId}-`) && name.endsWith(".sb")), []);
    }
    assert.deepEqual(fs.readdirSync(path.join(health.executorRoot, "profiles")).filter((name) => name.endsWith(".interactive")), []);
  };
  const liveTrace = () => readTraceEvents(eventLog);
  const boundary = () => liveTrace().length;
  let rowNumber = 0;
  const nextDirectory = () => {
    assert.equal(admissionClosed, false, "owned worker admission closed");
    const location = path.join(root, `row-${++rowNumber}`);
    fs.mkdirSync(location, { mode: 0o700 });
    return location;
  };
  const local = async (kind: "cpp" | "c" | "python", executable: string): Promise<ResolvedToolchain> => {
    assert.equal(admissionClosed, false, "owned worker admission closed");
    const selected = fs.realpathSync(executable);
    const probe = await scheduleLocalCompatibilityProbe(kind, selected);
    assert.equal(probe.status, "compatible", `${kind} ${selected}: ${JSON.stringify(probe)}`);
    const toolchain = verifyLocalToolchainCandidate(kind, selected);
    assert.equal(toolchain.ready, true, JSON.stringify(toolchain));
    assert.ok(toolchain.localToolchain, `${kind}: no verified direct local identity`);
    assert.equal(toolchain.localToolchain.isolation, "strict");
    t.diagnostic(JSON.stringify({ selectedLocalKind: kind, toolchain }));
    return toolchain;
  };
  const selectedCpp = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8" }).trim();
  const selectedC = execFileSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" }).trim();
  const cpp = await local("cpp", selectedCpp);
  const c = await local("c", selectedC);
  const managed = new Map<Language, ResolvedToolchain>();
  managed.set("cpp", cpp);
  managed.set("c", c);
  for (const language of ["python", "pascal", "java", "scratch"] as const) {
    const toolchain = resolveManagedToolchain(language);
    managed.set(language, toolchain);
    t.diagnostic(JSON.stringify({ selectedManagedKind: language, toolchain }));
  }
  const assertManaged = (toolchain: ResolvedToolchain) => {
    assert.equal(toolchain.ready, true, JSON.stringify(toolchain));
    assert.equal(toolchain.source, "managed", JSON.stringify(toolchain));
    assert.ok(toolchain.packageDigest && toolchain.packageComponentId, JSON.stringify(toolchain));
  };
  const python = managed.get("python");
  assert.ok(python);

  const submission = async (language: Language, directory: string, toolchain: ResolvedToolchain, actor?: OutcomeRow["actor"]) => {
    assert.equal(admissionClosed, false, "owned worker admission closed");
    const extension = { cpp: ".cpp", c: ".c", python: ".py", pascal: ".pas", java: ".java", scratch: ".sb3" }[language];
    const source = path.join(directory, `Main${extension}`);
    if (language === "scratch") {
      fs.copyFileSync(path.join(process.cwd(), "server", "test-fixtures", "corpus", "static", "scratch_ac", "project.sb3"), source);
    } else if ((language === "cpp" || language === "python") && !actor) {
      fs.copyFileSync(path.join(process.cwd(), "server", "test-fixtures", "corpus", "static", `${language === "cpp" ? "cpp" : "python"}_interactor`, `solution${extension}`), source);
    } else {
      const sources: Partial<Record<Language, string>> = {
        c: "#include <stdio.h>\nint main(void) { int x; if (scanf(\"%d\", &x) != 1) return 2; printf(\"%d\\n\", x * 2); fflush(stdout); return 0; }\n",
        pascal: "program Main; var x: LongInt; begin readln(x); writeln(x * 2); flush(output); end.\n",
        java: "import java.io.*; public class Main { public static void main(String[] args) throws Exception { int x = Integer.parseInt(new BufferedReader(new InputStreamReader(System.in)).readLine().trim()); System.out.println(x * 2); System.out.flush(); } }\n",
        cpp: "#include <iostream>\n#include <fstream>\n#include <string>\n#include <vector>\n#include <chrono>\n#include <thread>\nint main() { " +
          (actor === "memory" ? "std::cerr << \"memory-allocation-attempt\\n\" << std::flush; std::vector<char> bytes(128 * 1024 * 1024, 1); volatile int sum = 0; for (auto value : bytes) sum = sum + value; std::cerr << sum; std::this_thread::sleep_for(std::chrono::seconds(5)); " : "") +
          "int x; std::cin >> x; " +
          (actor === "output" ? "std::string block(65536, 'x'); for (;;) { std::cerr << block << std::flush; } " : "") +
          (actor === "write" ? "std::string block(16 * 1024 * 1024, 'x'); for (int i = 0; i < 9; ++i) { std::ofstream file(\"quota-\" + std::to_string(i)); file << block; } std::this_thread::sleep_for(std::chrono::seconds(30)); " : "") +
          (actor === "files" ? "for (int i = 0; i < 300; ++i) { std::ofstream file(\"quota-\" + std::to_string(i)); file << 'x'; } std::this_thread::sleep_for(std::chrono::seconds(30)); " : "") +
          (actor === "sleep" ? "std::this_thread::sleep_for(std::chrono::seconds(5)); " : "") +
          `std::cout << x * 2 << std::endl; ${actor === "peer-hold" ? "std::this_thread::sleep_for(std::chrono::seconds(30)); " : ""}return ${actor === "exit1" ? 1 : 0}; }\n`,
      };
      const text = sources[language];
      assert.ok(text, language);
      fs.writeFileSync(source, text);
    }
    const result = await compileSubmission({ language, contestantName: "student", problemName: "PAIR",
      submissionPath: source, tempDirectory: directory, compile: createCompileConfig(),
      toolchains: { [language]: toolchain }, cppToolchain: cpp, cToolchain: c, pythonToolchain: toolchain.kind === "python" ? toolchain : python });
    assert.equal(result.compileStatus, "OK", result.compileError);
    assert.ok(result.program, `${language}: production compiler returned no prepared program`);
    return { source, compiled: result };
  };
  const checker = async (role: Role, directory: string, toolchain: ResolvedToolchain, row: OutcomeRow) => {
    assert.equal(admissionClosed, false, "owned worker admission closed");
    const name = `interactor.${role === "cpp" ? "cpp" : "py"}`;
    const submissionQuota = row.actor === "output" || row.actor === "write" || row.actor === "files";
    const cppSource = "#include <iostream>\n#include <fstream>\n#include <string>\n#include <chrono>\n#include <thread>\n" +
      "int main(int argc, char** argv) { if (argc != 3) return 3; std::ifstream input(argv[1]); int x, expected; input >> x >> expected; std::cout << x << std::endl; " +
      (submissionQuota ? `std::cerr << ${JSON.stringify(row.message ?? "")} << std::flush; char buffer[65536]; while (std::cin.read(buffer, sizeof(buffer)) || std::cin.gcount() > 0) {} ` : "int actual; if (!(std::cin >> actual) || actual != expected) return 1; ") +
      (row.checkerActor === "output" ? "std::string block(65536, 'x'); for (;;) { std::cerr << block << std::flush; } " : "") +
      (row.checkerActor === "write" ? "std::string block(16 * 1024 * 1024, 'x'); for (int i = 0; i < 3; ++i) { std::ofstream file(\"quota-\" + std::to_string(i)); file << block; } std::this_thread::sleep_for(std::chrono::seconds(30)); " : "") +
      (row.checkerActor === "files" ? "for (int i = 0; i < 100; ++i) { std::ofstream file(\"quota-\" + std::to_string(i)); file << 'x'; } std::this_thread::sleep_for(std::chrono::seconds(30)); " : "") +
      (row.actor === "exit1" ? "std::string rest; while (std::getline(std::cin, rest)) {} " : "") +
      (row.checkerSleep ? "std::this_thread::sleep_for(std::chrono::seconds(30)); " : "") +
      `std::ofstream transcript(argv[2]); transcript << ${JSON.stringify(row.transcript ?? "")}; ${submissionQuota ? "" : `std::cerr << ${JSON.stringify(row.message ?? "")}; `}return ${row.exit}; }\n`;
    const pythonSource = "import sys,time\n" +
      "if len(sys.argv) != 3: sys.exit(3)\nx,expected = map(int,open(sys.argv[1]).read().split())\nprint(x,flush=True)\n" +
      (submissionQuota ? `sys.stderr.write(${JSON.stringify(row.message ?? "")})\nsys.stderr.flush()\nwhile sys.stdin.buffer.read(65536): pass\n` : "actual = int(input())\nif actual != expected: sys.exit(1)\n") +
      (row.checkerActor === "output" ? "while True:\n sys.stderr.write('x'*65536)\n sys.stderr.flush()\n" : "") +
      (row.checkerActor === "write" ? "for i in range(3):\n with open('quota-'+str(i),'w') as f: f.write('x'*(16*1024*1024))\ntime.sleep(30)\n" : "") +
      (row.checkerActor === "files" ? "for i in range(100):\n with open('quota-'+str(i),'w') as f: f.write('x')\ntime.sleep(30)\n" : "") +
      (row.actor === "exit1" ? "sys.stdin.read()\n" : "") + (row.checkerSleep ? "time.sleep(30)\n" : "") +
      `open(sys.argv[2],'w').write(${JSON.stringify(row.transcript ?? "")})\n${submissionQuota ? "" : `sys.stderr.write(${JSON.stringify(row.message ?? "")})\n`}sys.exit(${row.exit})\n`;
    fs.writeFileSync(path.join(directory, name), role === "cpp" ? cppSource : pythonSource);
    return resolveInteractor({ interactorName: name, problemName: "PAIR", problemDirectory: directory,
      tempDirectory: directory, cppToolchain: cpp, pythonToolchain: toolchain });
  };
  const execute = async (language: Language, role: Role, toolchain: ResolvedToolchain, checkerToolchain: ResolvedToolchain, row: OutcomeRow, refuseStrict = false) => {
    const directory = nextDirectory();
    const { source, compiled } = await submission(language, directory, toolchain, row.actor);
    const interactor = await checker(role, directory, checkerToolchain, row);
    assert.equal(interactor.error, undefined, JSON.stringify(interactor));
    assert.ok(interactor.path, JSON.stringify(interactor));
    const input = path.join(directory, "input.txt");
    fs.writeFileSync(input, language === "scratch" ? "42 42\n" : "21 42\n");
    const maximum = parseRational(row.maximum ?? "1");
    const config: NormalizedProblemConfig = { useStdIO: true, useStdIn: true, useStdOut: true,
      inputFile: "PAIR.inp", outputFile: "PAIR.out", totalScore: 1, defaultScore: 1, testScores: {},
      memoryLimit: row.actor === "memory" ? 16 : 512, checkerType: "C1", isInteractive: true,
      compile: createCompileConfig(), polygonConfig: { enableGroups: false, tests: {}, groups: {} } };
    const firstLine = boundary();
    lastNativeResult = undefined;
    assert.equal(admissionClosed, false, "owned worker admission closed");
    const job = tryRegisterJudgeJob(undefined);
    assert.equal(job.accepted, true, "expected judge job registration to succeed");
    const pending = runTestCase({ contestant: "student", problemName: "PAIR", testName: "1", language,
      submissionPath: source, executablePath: compiled.executablePath, inputPath: input,
      expectedOutputPath: path.join(directory, "absent-answer.txt"), expectedOutputPreview: "",
      testRoot: directory, contestantsRoot: directory, tempDirectory: directory, pythonCommand: "",
      // Separate memory actor from sleep actor so cold Mach-O sandbox-exec/dyld initialization
      // (~500ms) cannot race a 500ms wall-time watchdog before main() begins allocation.
      timeLimitMs: row.actor === "sleep" ? 500 : 5_000, score: rationalToNumber(maximum), scoreExact: maximum,
      config, checker: undefined, interactor, program: compiled.program, jobId: job.jobId });
    let result: Awaited<typeof pending>;
    try {
      result = await pending;
    } finally {
      job.finish();
    }
    if (admissionClosed) {
      await stop();
      await assertDrained(firstLine, false);
      return result;
    }
    if (refuseStrict) {
      const refusal = result;
      assert.equal(refusal.status, "JE", JSON.stringify(refusal));
      assert.match(refusal.errorDetail ?? "", /interactive participants require strict isolation/);
      assert.deepEqual(refusal.scoreExact, parseRational("0"));
      assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "interactive_spool_created" || event.event === "supervisor_registered"), []);
      await assertDrained(firstLine, false);
      return;
    }
    const nativeResult = lastNativeResult;
    assert.ok(nativeResult, "expected the actual production framed interactive response");
    if (row.checkerActor) {
      assert.equal(nativeResult.interactorResult.reason,
        row.checkerActor === "output" ? "output_limit" : "write_limit", JSON.stringify(nativeResult));
      assert.equal(nativeResult.scoreMultiplier, 0, JSON.stringify(nativeResult));
    }
    if (row.actor === "output" || row.actor === "write" || row.actor === "files") {
      t.diagnostic(`${role} ${row.name}: ${JSON.stringify(nativeResult)}`);
      assert.equal(nativeResult.submissionResult.reason,
        row.actor === "output" ? "output_limit" : "write_limit", JSON.stringify(nativeResult));
      assert.equal(nativeResult.scoreMultiplier, 0, JSON.stringify(nativeResult));
    }
    assert.equal(result.status, row.status, JSON.stringify(result));
    if (row.actor === "write" && row.message !== undefined) {
      assert.equal(result.checkerMessage, row.message, "quota zero award must survive the actual emitted partial-score carrier");
    }
    if (row.status === "AC" && row.message === undefined) {
      assert.equal(result.checkerMessage, "ok", "protocol stdout must not replace the canonical checker diagnostic");
    }
    assert.deepEqual(result.scoreExact, parseRational(row.exact), JSON.stringify(result));
    if (row.display !== undefined) assert.equal(result.score, row.display, JSON.stringify(result));
    if (row.exact === "0") assert.equal(result.score, 0, JSON.stringify(result));
    if (row.actor === "exit1") assert.equal(result.execution?.exitCode, 1, JSON.stringify(result));
    if (row.actor === "sleep") assert.equal(result.execution?.reason, "wall_time_limit", JSON.stringify(result));
    if (row.actor === "output") assert.equal(result.execution?.reason, "output_limit", JSON.stringify(result));
    if (row.actor === "write" || row.actor === "files") assert.equal(result.execution?.reason, "write_limit", JSON.stringify(result));
    if (row.actor === "memory") {
      assert.equal(result.execution?.reason, "memory_limit", JSON.stringify(result));
      assert.ok((result.execution?.stderrBytes ?? 0) > 0, "memory fixture entered the allocation attempt");
    }
    await assertDrained(firstLine, true);
    return result;
  };
  try {
    for (const language of languages) {
      for (const role of ["cpp", "python"] as const) {
        await runCase("baseline", `${language} release submission / ${role} interactor AC`, async () => {
          const toolchain = managed.get(language);
          assert.ok(toolchain);
          if (language !== "cpp" && language !== "c") assertManaged(toolchain);
          if (role === "python") assertManaged(python);
          await execute(language, role, toolchain, python, { name: "AC", exit: 0, exact: "1", status: "AC" });
        });
      }
    }
    for (const role of ["cpp", "python"] as const) {
      await runCase("local-python", `strict local Python submission / ${role} interactor`, async () => {
        const selected = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_LOCAL_PYTHON;
        assert.ok(selected);
        const localPython = await local("python", selected);
        await execute("python", role, localPython, role === "python" ? localPython : python,
          { name: "AC", exit: 0, exact: "1", status: "AC" });
      });
    }
    await runCase("local-python", "C++ submission / strict local Python interactor syntax and execution", async () => {
      const selected = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_LOCAL_PYTHON;
      assert.ok(selected);
      const localPython = await local("python", selected);
      await execute("cpp", "python", cpp, localPython, { name: "AC", exit: 0, exact: "1", status: "AC" });
    });
    for (const role of ["cpp", "python"] as const) {
      for (const row of outcomeRows) {
        await runCase("verdicts", `${role} interactor / ${row.name}`, async () => {
          if (role === "python") assertManaged(python);
          await execute("cpp", role, cpp, python, row);
        });
      }
    }
    for (const kind of ["go", "rust", "javascript", "csharp"] as const) {
      await runCase("refusals", `${kind} dormant release selection refuses`, () => {
        assert.throws(() => getRegisteredProfileForKind(kind), /registered|release|unsupported|unknown/i);
      });
    }
    for (const extension of ["c", "pas", "java", "go", "rs", "js", "cs", "sb3", "txt", "exe"]) {
      await runCase("refusals", `unsupported ${extension} interactor refuses without launch`, async () => {
        const directory = nextDirectory();
        fs.writeFileSync(path.join(directory, `interactor.${extension}`), "harmless\n");
        const firstLine = boundary();
        const resolved = await resolveInteractor({ interactorName: `interactor.${extension}`, problemName: "PAIR",
          problemDirectory: directory, tempDirectory: directory, cppToolchain: cpp, pythonToolchain: python });
        assert.equal(resolved.path, null);
        assert.match(resolved.error ?? "", /unsupported|windows/i);
        assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "target_started" || event.event === "interactive_spool_created"), []);
        await assertDrained(firstLine, false);
      });
    }
    await runCase("refusals", "missing selected compiler refuses without fallback", async () => {
      const directory = nextDirectory();
      fs.writeFileSync(path.join(directory, "interactor.cpp"), "int main() { return 0; }\n");
      const firstLine = boundary();
      const missing = verifyLocalToolchainCandidate("cpp", path.join(directory, "missing-clang++"));
      assert.equal(missing.ready, false);
      const resolved = await resolveInteractor({ interactorName: "interactor.cpp", problemName: "PAIR",
        problemDirectory: directory, tempDirectory: directory, cppToolchain: missing });
      assert.equal(resolved.path, null);
      assert.ok(resolved.error);
      assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "target_started"), []);
    });
    await runCase("refusals", "missing selected Python runtime refuses without fallback", async () => {
      const directory = nextDirectory();
      fs.writeFileSync(path.join(directory, "interactor.py"), "print('harmless')\n");
      const firstLine = boundary();
      const missing = verifyLocalToolchainCandidate("python", path.join(directory, "missing-python"));
      assert.equal(missing.ready, false);
      const resolved = await resolveInteractor({ interactorName: "interactor.py", problemName: "PAIR",
        problemDirectory: directory, tempDirectory: directory, pythonToolchain: missing });
      assert.equal(resolved.path, null);
      assert.match(resolved.error ?? "", /INTERACTOR_TOOLCHAIN_UNAVAILABLE/);
      assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "target_started" || event.event === "interactive_spool_created"), []);
    });
    await runCase("refusals", "uncertified selected local Python remains not ready and refuses before launch", async () => {
      const selected = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_LOCAL_PYTHON;
      assert.ok(selected);
      const directory = nextDirectory();
      const unprobedPath = path.join(directory, "unprobed-python");
      fs.copyFileSync(fs.realpathSync(selected), unprobedPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(unprobedPath, 0o500);
      fs.writeFileSync(path.join(directory, "Main.py"), "print(42)\n");
      fs.writeFileSync(path.join(directory, "interactor.py"), "print('harmless')\n");
      const firstLine = boundary();
      const unprobed = verifyLocalToolchainCandidate("python", unprobedPath);
      assert.equal(unprobed.ready, false, JSON.stringify(unprobed));
      assert.equal(unprobed.localToolchain, undefined, JSON.stringify(unprobed));
      assert.notEqual(unprobed.localProbe?.status, "compatible", JSON.stringify(unprobed));
      const probe = await scheduleLocalCompatibilityProbe("python", unprobedPath);
      assert.equal(probe.status, "incompatible", JSON.stringify(probe));
      const afterProbe = verifyLocalToolchainCandidate("python", unprobedPath);
      assert.equal(afterProbe.ready, false, JSON.stringify(afterProbe));
      assert.equal(afterProbe.localToolchain, undefined, JSON.stringify(afterProbe));
      const compiled = await compileSubmission({ language: "python", contestantName: "student", problemName: "PAIR",
        submissionPath: path.join(directory, "Main.py"), tempDirectory: directory, compile: createCompileConfig(),
        toolchains: { python: afterProbe }, pythonToolchain: afterProbe });
      assert.equal(compiled.compileStatus, "JE", JSON.stringify(compiled));
      assert.equal(compiled.failureKind, "infrastructure", JSON.stringify(compiled));
      const resolved = await resolveInteractor({ interactorName: "interactor.py", problemName: "PAIR",
        problemDirectory: directory, tempDirectory: directory, pythonToolchain: afterProbe });
      assert.equal(resolved.path, null, JSON.stringify(resolved));
      assert.match(resolved.error ?? "", /INTERACTOR_TOOLCHAIN_UNAVAILABLE/);
      const strictPython = await local("python", selected);
      assert.equal(strictPython.localToolchain?.isolation, "strict");
      assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "interactive_spool_created"), []);
      await assertDrained(firstLine, false);
    });
    await runCase("refusals", "invalid Python interactor syntax refuses before pair launch", async () => {
      assertManaged(python);
      const directory = nextDirectory();
      fs.writeFileSync(path.join(directory, "interactor.py"), "def broken(:\n");
      const firstLine = boundary();
      const resolved = await resolveInteractor({ interactorName: "interactor.py", problemName: "PAIR",
        problemDirectory: directory, tempDirectory: directory, pythonToolchain: python });
      assert.equal(resolved.path, null);
      assert.match(resolved.error ?? "", /PYTHON_INTERACTOR_COMPILE_ERROR/);
      assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "interactive_spool_created"), []);
      await assertDrained(firstLine, false);
    });
    for (const side of ["submission", "checker"] as const) {
      await runCase("refusals", `ResourceOnly ${side} refuses through the production caller`, async () => {
        const selected = process.env.JUDGEDESK_INTERACTIVE_PRODUCTION_LOCAL_PYTHON;
        assert.ok(selected);
        const localPython = await local("python", selected);
        const resourceOnly: ResolvedToolchain = { ...localPython,
          localToolchain: deriveLocalToolchain("python", fs.realpathSync(selected), "resource-only").identity };
        const firstLine = boundary();
        await execute("python", "python",
          side === "submission" ? resourceOnly : localPython,
          side === "checker" ? resourceOnly : python,
          { name: "refusal", exit: 0, exact: "1", status: "AC" }, true);
        assert.deepEqual(liveTrace().slice(firstLine).filter((event) => event.event === "interactive_spool_created"), []);
        await assertDrained(firstLine, false);
      });
    }
  } finally {
    try {
      await stop();
      const stdioClose = await executorClient.waitForStdioClose();
      assert.equal(stdioClose, true, "expected native executor stdio close and finalizers");
      await assertDrained(0, false);
      await waitForProcessGone(executorIdentity.pid, 5_000);
      await waitForGenerationExclusive(generationPath, 10_000);
      const remainingProfiles = fs.readdirSync(path.join(health.executorRoot, "profiles"));
      assert.deepEqual(remainingProfiles, []);
      const workspacesDir = path.join(health.executorRoot, "workspaces");
      const remainingWorkspaces = fs.existsSync(workspacesDir) ? fs.readdirSync(workspacesDir) : [];
      assert.deepEqual(remainingWorkspaces, []);
      const receiptPath = path.join(runRoot, "completed-rows.json");
      const receiptTempPath = `${receiptPath}.tmp-${process.pid}`;
      fs.writeFileSync(receiptTempPath, JSON.stringify({
        selectedCases: selectedCases ?? null,
        rows: completedRows,
        aborted: admissionClosed,
        cleanupProved: true,
        barriers: {
          nativeDrain: true,
          callerSettlement: true,
          stdioClose,
          finalizers: true,
          workspaceInventory: remainingWorkspaces,
          profiles: remainingProfiles,
          leaseRelease: true,
        },
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(receiptTempPath, receiptPath);
    } catch (error) {
      t.diagnostic(`failure evidence retained: ${runRoot}\n${fs.readFileSync(eventLog, "utf8")}`);
      throw error;
    } finally {
      process.off("SIGTERM", terminate);
    }
  }
});
