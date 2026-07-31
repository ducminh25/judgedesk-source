import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.JUDGEDESK_GATE_APP
  || path.join(
    repositoryRoot,
    "src-tauri",
    "target",
    "aarch64-apple-darwin",
    "release",
    "bundle",
    "macos",
    "JudgeDesk.app",
  );
const bin = path.join(app, "Contents", "MacOS");
const guiCommand = path.join(bin, "themis-v2");
const helperCommand = `${guiCommand} --judgedesk-internal-job-supervisor-v1`;
const serverCommand = path.join(bin, "server");
const executorCommand = path.join(bin, "judgedesk-executor");
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "judgedesk-packaged-checker-gate-"),
);
const appData = path.join(temporaryRoot, "app-data");
const contestants = path.join(temporaryRoot, "contestants");
const tests = path.join(temporaryRoot, "tests");
const logPath = path.join(temporaryRoot, "app.log");
const logDescriptor = fs.openSync(logPath, "a");
const executorRoot = path.join(os.tmpdir(), "JudgeDeskExecutor");
const baselineWorkspaces = directoryEntrySet(path.join(executorRoot, "workspaces"));
const baselineProfiles = directoryEntrySet(path.join(executorRoot, "profiles"));
let gui = null;
let baseUrl = "";
let installedPython = false;
let failure = null;

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The packaged checker gate requires Apple Silicon macOS.");
}
if (!fs.statSync(app).isDirectory() || !fs.statSync(guiCommand).isFile()) {
  throw new Error(`Packaged app is unavailable: ${app}`);
}

try {
  assert.deepEqual(
    baselineWorkspaces,
    [],
    "Executor workspace cache is not empty before the packaged checker gate.",
  );
  assert.deepEqual(
    baselineProfiles,
    [],
    "Seatbelt profile cache is not empty before the packaged checker gate.",
  );
  assert.equal(
    (await runtimeRows()).length,
    0,
    "Refusing to disrupt an existing JudgeDesk app bundle.",
  );
  provisionFixture();
  fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
  gui = spawn(guiCommand, [], {
    env: { ...process.env, THEMIS_APP_DATA_DIR: appData },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  gui.once("error", (error) => {
    failure ??= error;
  });

  const inventory = await waitForCoreInventory();
  const server = inventory.find((row) => row.command === serverCommand);
  assert.ok(server, "Packaged backend process was not found.");
  const port = await waitForListeningPort(server.pid);
  baseUrl = `http://127.0.0.1:${port}`;

  const status = await requestJson("GET", "/api/status");
  assert.equal(status.secureRunner?.ready, true);
  assert.equal(status.build?.gitCommit, await currentCommit());

  const initialToolchains = await requestJson("GET", "/api/toolchains");
  assert.equal(initialToolchains.registryRevision, 4);
  assert.deepEqual(
    initialToolchains.profiles?.map((profile) => profile.id),
    [
      "cpp-legacy-v1",
      "c-gcc14",
      "python-cpython312",
      "pascal-fpc322",
      "java-temurin21",
    ],
  );
  for (const profile of initialToolchains.profiles || []) {
    assert.deepEqual(
      Object.keys(profile.sources || {}).sort(),
      ["local_auto", "local_path", "managed", "none"],
    );
  }
  assert.equal(initialToolchains.capabilities?.python?.managed, false);
  const installResponse = await requestJson(
    "POST",
    "/api/toolchains/python-macos-arm64/install",
  );
  assert.equal(installResponse.success, true);
  installedPython = true;
  await waitForManagedPythonInstallation();
  const selection = await requestJson("POST", "/api/toolchains/custom-path", {
    kind: "python",
    preferredSource: "managed",
  });
  assert.equal(selection.success, true);
  await requestJson("POST", "/api/toolchains/rescan");
  await waitFor(async () => {
    const toolchains = await requestJson("GET", "/api/toolchains");
    return toolchains.discovery?.status === "complete"
      && toolchains.capabilities?.cpp?.submissionReady === true
      && toolchains.active?.python?.source === "managed"
      && toolchains.capabilities?.python?.checkerReady === true;
  }, 20_000, "registry sources never became ready after rescan");

  const normalEvents = await runJudge("packaged_checker_normal", ["A", "B"]);
  assertNoJudgeError(normalEvents);
  assertAccepted(normalEvents, "A", "CHECKER_CPP_OK");
  assertAccepted(normalEvents, "B", "CHECKER_PY_OK");

  const cancelJobId = "packaged_checker_cancel";
  const cancelledRun = runJudge(cancelJobId, ["C"]);
  await waitFor(async () => {
    const rows = await processRows();
    return rows.some((row) =>
      row.command.includes("/JudgeDeskExecutor/toolchains/")
      && row.command.includes("/checker.py")
    );
  }, 45_000, "sleeping packaged Python checker never became active");
  const lockedToolchains = await requestJson("GET", "/api/toolchains");
  assert.equal(lockedToolchains.mutationsBlocked, true);
  const blockedRescan = await fetch(`${baseUrl}/api/toolchains/rescan`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(blockedRescan.status, 409);
  assert.match(await blockedRescan.text(), /while judging is in progress/i);
  const cancelStartedAt = Date.now();
  const cancellation = await requestJson("POST", "/api/batch-judge/cancel", {
    jobId: cancelJobId,
  });
  assert.equal(cancellation.success, true);
  assert.ok(Date.now() - cancelStartedAt < 20_000, "checker cancellation exceeded its drain bound");
  const cancelEvents = await cancelledRun;
  assertNoJudgeError(cancelEvents);
  assert.ok(cancelEvents.some((event) => event.type === "done"));
  await waitFor(async () => {
    const rows = await processRows();
    return !rows.some((row) => row.command.includes("/checker.py"));
  }, 10_000, "cancelled packaged checker process remained alive");
  const statusAfterCancel = await requestJson("GET", "/api/status");
  assert.equal(statusAfterCancel.secureRunner?.ready, true);

  const uninstall = await requestJson(
    "DELETE",
    "/api/toolchains/python-macos-arm64",
  );
  assert.equal(uninstall.success, true);
  installedPython = false;
  console.log("macOS packaged C++/Python checker and cancellation gate passed.");
} catch (error) {
  failure = error;
} finally {
  if (installedPython && baseUrl) {
    try {
      await requestJson("DELETE", "/api/toolchains/python-macos-arm64");
    } catch {
      // The isolated app-data directory is removed after the process tree drains.
    }
  }
  await stopPackagedApp();
  fs.closeSync(logDescriptor);
  try {
    assert.deepEqual(
      directoryEntrySet(path.join(executorRoot, "workspaces")),
      baselineWorkspaces,
      "Packaged checker gate leaked an executor workspace.",
    );
    assert.deepEqual(
      directoryEntrySet(path.join(executorRoot, "profiles")),
      baselineProfiles,
      "Packaged checker gate leaked a Seatbelt profile.",
    );
    assert.equal((await runtimeRows()).length, 0, "Packaged app process tree remained alive.");
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
  if (failure) {
    const logTail = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").split("\n").slice(-80).join("\n")
      : "";
    if (logTail.trim()) console.error(logTail);
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failure) throw failure;

function provisionFixture() {
  for (const problem of ["A", "B", "C"]) {
    const contestantDirectory = path.join(contestants, "alice");
    const problemDirectory = path.join(tests, problem);
    const testDirectory = path.join(problemDirectory, "01");
    fs.mkdirSync(contestantDirectory, { recursive: true });
    fs.mkdirSync(testDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(contestantDirectory, `${problem}.cpp`),
      "#include <iostream>\nint main() { std::cout << 42 << '\\n'; return 0; }\n",
      "utf8",
    );
    fs.writeFileSync(path.join(testDirectory, "input.inp"), "42\n", "utf8");
    fs.writeFileSync(path.join(testDirectory, "answer.out"), "42\n", "utf8");
  }
  fs.writeFileSync(
    path.join(tests, "A", "checker.cpp"),
    [
      '#include "testlib.h"',
      "int main(int argc, char** argv) {",
      "  registerTestlibCmd(argc, argv);",
      "  const long long actual = ouf.readLong();",
      "  const long long expected = ans.readLong();",
      "  ouf.skipBlanks();",
      "  ouf.readEof();",
      "  if (actual != expected) quitf(_wa, \"mismatch\");",
      "  quitf(_ok, \"CHECKER_CPP_OK\");",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tests, "B", "checker.py"),
    [
      "from pathlib import Path",
      "import sys",
      "actual = Path(sys.argv[2]).read_text(encoding='utf-8').strip()",
      "expected = Path(sys.argv[3]).read_text(encoding='utf-8').strip()",
      "print('CHECKER_PY_OK')",
      "raise SystemExit(0 if actual == expected else 1)",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tests, "C", "checker.py"),
    [
      "import time",
      "time.sleep(60)",
      "print('CHECKER_CANCEL_FAILED')",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function runJudge(jobId, problems) {
  const problemConfigs = Object.fromEntries(problems.map((problem) => [
    problem,
    {
      useStdIO: true,
      defaultScore: 10,
      checkerType: problem === "A" ? "checker.cpp" : "checker.py",
    },
  ]));
  const response = await fetch(`${baseUrl}/api/batch-judge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      thisinhPath: contestants,
      testPath: tests,
      targetContestants: ["alice"],
      targetProblems: problems,
      problemConfigs,
      jobId,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  return body
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function assertNoJudgeError(events) {
  const error = events.find((event) => event.type === "error");
  assert.equal(error, undefined, error ? JSON.stringify(error) : "");
}

function assertAccepted(events, problemName, marker) {
  const event = events.find((candidate) =>
    candidate.type === "problem_completed"
    && candidate.data?.problemResult?.problemName === problemName
  );
  assert.ok(event, `No result was returned for problem ${problemName}.`);
  const result = event.data.problemResult;
  assert.equal(result.compileStatus, "OK", result.compileError || "compile failed");
  assert.equal(result.summary.status, "AC", JSON.stringify(result));
  assert.equal(result.testCases.length, 1);
  assert.equal(result.testCases[0].status, "AC", JSON.stringify(result.testCases[0]));
  assert.match(result.testCases[0].checkerMessage || "", new RegExp(marker));
}

async function waitForManagedPythonInstallation() {
  await waitFor(async () => {
    const state = await requestJson("GET", "/api/toolchains");
    const python = state.toolchains?.find(
      (toolchain) => toolchain.id === "python-macos-arm64",
    );
    if (python?.progress?.status === "failed") {
      throw new Error(python.progress.error || "Managed Python installation failed.");
    }
    return python?.installed === true;
  }, 5 * 60_000, "managed Python installation timed out", 250);
}

async function requestJson(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${method} ${pathname}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function waitForCoreInventory() {
  return waitFor(async () => {
    if (failure) throw failure;
    const rows = await processRows();
    const commands = [guiCommand, helperCommand, serverCommand, executorCommand];
    const matches = rows.filter((row) => commands.includes(row.command));
    return commands.every(
      (command) => matches.filter((row) => row.command === command).length === 1,
    ) ? matches : false;
  }, 15_000, "packaged app did not establish one complete process generation");
}

async function waitForListeningPort(pid) {
  return waitFor(async () => {
    try {
      const { stdout } = await execFile("lsof", [
        "-Pan",
        "-p",
        String(pid),
        "-iTCP",
        "-sTCP:LISTEN",
        "-Fn",
      ]);
      const match = stdout.match(/^n127\.0\.0\.1:(\d+)$/m);
      return match ? Number(match[1]) : false;
    } catch {
      return false;
    }
  }, 15_000, "packaged backend did not open a loopback listening port");
}

async function waitFor(operation, timeoutMs, description, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(description);
}

async function stopPackagedApp() {
  if (!gui) return;
  try {
    await execFile("osascript", [
      "-e",
      'tell application id "com.themisv2.judge" to quit',
    ]);
  } catch {}
  try {
    await waitFor(async () => (await runtimeRows()).length === 0, 15_000, "", 50);
    return;
  } catch {}
  if (isProcessAlive(gui.pid)) process.kill(gui.pid, "SIGTERM");
  try {
    await waitFor(async () => (await runtimeRows()).length === 0, 10_000, "", 50);
    return;
  } catch {}
  if (isProcessAlive(gui.pid)) process.kill(gui.pid, "SIGKILL");
  await waitFor(
    async () => (await runtimeRows()).length === 0,
    15_000,
    "packaged app did not drain after exact GUI termination",
    50,
  );
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runtimeRows() {
  const rows = await processRows();
  return rows.filter((row) =>
    /\/JudgeDesk[.]app\/Contents\/MacOS\/(?:themis-v2|server|judgedesk-executor)(?: |$)/.test(
      row.command,
    )
  );
}

async function processRows() {
  const { stdout } = await execFile("ps", ["-axo", "pid=,ppid=,pgid=,command="]);
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }));
}

async function currentCommit() {
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  return stdout.trim();
}

function directoryEntrySet(directory) {
  try {
    return fs.readdirSync(directory).sort();
  } catch {
    return [];
  }
}
