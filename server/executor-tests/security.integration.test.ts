import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ExecutorLimits, ExecutorRunResult } from "../executor/protocol.js";

interface OwnedMacosTreeGuard {
  directory: string;
}

interface OwnedWindowsExecutorEnvironment {
  root: string;
  hostExecutorRoot: string;
  hostExecutorState: Map<string, string>;
  previous: Record<string, string | undefined>;
}

const TEST_ROOT_MARKER = "judgedesk-test-owned\n";

function snapshotTree(root: string): Map<string, string> {
  const state = new Map<string, string>();
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) {
        state.set(relativePath, `link:${fs.readlinkSync(fullPath)}`);
      } else if (entry.isDirectory()) {
        state.set(relativePath, "directory");
        walk(fullPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        state.set(relativePath, `file:${content.length}:${hash}`);
      }
    }
  };
  walk(root);
  return new Map([...state.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function provisionWindowsExecutorEnvironment(): OwnedWindowsExecutorEnvironment | null {
  if (process.platform !== "win32") return null;

  const hostLocalAppData = process.env.LOCALAPPDATA
    || path.join(os.homedir(), "AppData", "Local");
  const hostThemisRoot = process.env.THEMIS_APP_DATA_DIR
    || path.join(hostLocalAppData, "ThemisV2");
  const hostExecutorRoot = path.join(hostLocalAppData, "JudgeDesk", "JudgeDeskExecutor");
  const hostExecutorState = snapshotTree(hostExecutorRoot);
  const keys = [
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "THEMIS_APP_DATA_DIR",
  ] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) previous[key] = process.env[key];

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd_test_executor_security_"));
  try {
    fs.writeFileSync(path.join(root, ".judgedesk-test-root"), TEST_ROOT_MARKER, {
      encoding: "utf8",
      flag: "wx",
    });
    const localAppData = path.join(root, "localappdata");
    const roamingAppData = path.join(root, "roamingappdata");
    const temp = path.join(root, "temp");
    const isolatedThemisRoot = path.join(localAppData, "ThemisV2");
    fs.mkdirSync(localAppData, { recursive: true });
    fs.mkdirSync(roamingAppData, { recursive: true });
    fs.mkdirSync(temp, { recursive: true });
    const hostPythonPackage = path.join(
      hostThemisRoot,
      "toolchains",
      "python-windows-x64",
    );
    if (fs.existsSync(hostPythonPackage)) {
      fs.cpSync(
        hostPythonPackage,
        path.join(isolatedThemisRoot, "toolchains", "python-windows-x64"),
        { recursive: true, errorOnExist: true },
      );
    }
    process.env.LOCALAPPDATA = localAppData;
    process.env.APPDATA = roamingAppData;
    process.env.TEMP = temp;
    process.env.TMP = temp;
    process.env.THEMIS_APP_DATA_DIR = isolatedThemisRoot;
    return { root, hostExecutorRoot, hostExecutorState, previous };
  } catch (setupError) {
    const cleanupErrors: unknown[] = [];
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [setupError, ...cleanupErrors],
        `Failed to provision and clean isolated Windows executor root at ${root}`,
      );
    }
    throw setupError;
  }
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
    assert.equal(process.env.JUDGEDESK_TREE_GUARD_REQUIRED, "1");
    return null;
  }
  assert.equal(
    present.length,
    0,
    `partial macOS process-tree guard environment: ${present.join(", ")}`,
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-security-tree-guard-"),
  );
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
}

const ownedWindowsExecutorEnvironment = provisionWindowsExecutorEnvironment();
const ownedMacosTreeGuard = provisionMacosTreeGuard();
const [
  { executorClient },
  { DEFAULT_EXECUTOR_LIMITS },
  { createExecutorWorkspace, importExecutorArtifact },
  { prepareIsolatedPythonRuntime, prepareIsolatedPythonScript },
  { buildCheckerExecutorRunSpec, buildSubmissionExecutorRunSpec },
  { resolveManagedToolchain },
] = await Promise.all([
  import("../executor/client.js"),
  import("../executor/protocol.js"),
  import("../executor/workspace.js"),
  import("../judge/python-runtime.js"),
  import("../judge/execution-request.js"),
  import("../toolchains/resolver.js"),
]);

const MiB = 1024 * 1024;
const managedPython = resolveManagedToolchain("python");
const helperBinary = path.join(
  process.cwd(),
  "src-tauri",
  "binaries",
  process.platform === "win32"
    ? "judgedesk-executor-x86_64-pc-windows-msvc.exe"
    : `judgedesk-executor-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
);
after(async () => {
  const errors: unknown[] = [];
  try {
    await executorClient.shutdown();
  } catch (error) {
    errors.push(error);
  }
  if (ownedMacosTreeGuard) {
    try {
      fs.rmSync(ownedMacosTreeGuard.directory, { recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (ownedWindowsExecutorEnvironment) {
    for (const [key, value] of Object.entries(ownedWindowsExecutorEnvironment.previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(ownedWindowsExecutorEnvironment.root, { recursive: true, force: true });
      assert.equal(
        fs.existsSync(ownedWindowsExecutorEnvironment.root),
        false,
        `isolated Windows executor root still exists: ${ownedWindowsExecutorEnvironment.root}`,
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      assert.deepEqual(
        snapshotTree(ownedWindowsExecutorEnvironment.hostExecutorRoot),
        ownedWindowsExecutorEnvironment.hostExecutorState,
        "real JudgeDeskExecutor AppData changed during the security integration suite",
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Security integration teardown failed.");
  }
});

test("security fixtures can only reach the native executor harness", () => {
  const harness = fs.readFileSync(import.meta.filename, "utf8");
  assert.doesNotMatch(harness, /from\s+["'](?:node:)?child_process["']/);
  assert.doesNotMatch(harness, /\bspawn\s*\(/);
  for (const relative of [
    "server/judge/compiler.ts",
    "server/judge/testcase-runner.ts",
    "server/judge/custom-checker-runner.ts",
    "server/judge/python-checker.ts",
    "server/jobs.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:node:)?child_process["']/);
    assert.doesNotMatch(source, /tree-kill|tasklist|sandbox-exec/);
  }
  assert.ok(fs.existsSync(path.join(process.cwd(), "server/security-fixtures/cpp/resource_attacks.cpp")));
  assert.ok(fs.existsSync(path.join(process.cwd(), "server/security-fixtures/python/resource_attacks.py")));
});

test("macOS Seatbelt contract rejects every process-group escape path by role", () => {
  const macosPlatform = fs.readFileSync(
    path.join(process.cwd(), "native-executor/src/platform/macos.rs"),
    "utf8",
  );
  const securityProbe = fs.readFileSync(
    path.join(process.cwd(), "native-executor/src/security_probe.rs"),
    "utf8",
  );
  assert.match(
    macosPlatform,
    /RunRole::Submission[\s\S]*?RunRole::Checker[\s\S]*?RunRole::CheckerRuntime[\s\S]*?RunRole::SecurityProbe[\s\S]*?SYS_setpgid SYS_setsid SYS_posix_spawn/,
  );
  assert.match(
    macosPlatform,
    /RunRole::Compiler[\s\S]*?SYS_setpgid SYS_setsid(?! SYS_posix_spawn)/,
  );
  assert.match(macosPlatform, /setpgidBlockedWithEperm/);
  assert.match(macosPlatform, /setsidBlockedWithEperm/);
  assert.match(macosPlatform, /posixSpawnGroupBlockedWithEperm/);
  assert.match(macosPlatform, /forbiddenExecBlockedWithEperm/);
  assert.match(securityProbe, /libc::POSIX_SPAWN_SETPGROUP/);
  assert.match(securityProbe, /spawn_result == libc::EPERM/);
  assert.match(securityProbe, /result < 0 && error == libc::EPERM && group_unchanged/);
  assert.match(securityProbe, /libc::execve/);
});

test("startup self-test proves the platform boundaries before hostile fixtures run", async () => {
  assert.ok(fs.existsSync(helperBinary), `Build the native executor first: ${helperBinary}`);
  const health = await executorClient.start();
  assert.equal(health.ready, true, health.diagnostics.join("; "));
  assert.equal(health.networkBlocked, true);
  assert.equal(health.filesystemIsolated, true);
  assert.equal(health.processTreeControlled, true);
  assert.equal(health.memoryLimitSupported, true);
});

test(
  "concurrent runs cannot read or overwrite a sibling workspace",
  { timeout: 20_000 },
  async () => {
    const first = await createExecutorWorkspace();
    const second = await createExecutorWorkspace();
    try {
      first.stage(helperBinary, "probe.exe", true);
      second.stage(helperBinary, "probe.exe", true);
      const firstSecret = path.join(first.path, "secret.txt");
      const secondSecret = path.join(second.path, "secret.txt");
      fs.writeFileSync(firstSecret, "FIRST_PRIVATE", "utf8");
      fs.writeFileSync(secondSecret, "SECOND_PRIVATE", "utf8");

      const runProbe = async (
        workspace: typeof first,
        siblingSecret: string,
        label: string,
      ) => {
        const result = await executorClient.run({
          runId: `workspace_${label}_${crypto.randomUUID().replaceAll("-", "_")}`,
          role: "security-probe",
          workspaceId: workspace.id,
          executableId: workspace.relative("probe.exe"),
          args: ["--test-file-network-probe", siblingSecret],
          stdoutFile: "stdout.txt",
          stderrFile: "stderr.txt",
          environment: {},
          limits: {
            ...DEFAULT_EXECUTOR_LIMITS.submission,
            wallTimeMs: 3_000,
            memoryBytes: 128 * MiB,
          },
        });
        const stdout = fs.readFileSync(
          path.join(workspace.path, "stdout.txt"),
          "utf8",
        );
        assert.equal(result.reason, "exited", JSON.stringify(result));
        assert.equal(result.exitCode, 0, stdout);
        const probe = JSON.parse(stdout) as Record<string, unknown>;
        assert.equal(probe.readBlocked, true, stdout);
        assert.equal(probe.writeBlocked, true, stdout);
      };

      await Promise.all([
        runProbe(first, secondSecret, "first"),
        runProbe(second, firstSecret, "second"),
      ]);
      assert.equal(fs.readFileSync(firstSecret, "utf8"), "FIRST_PRIVATE");
      assert.equal(fs.readFileSync(secondSecret, "utf8"), "SECOND_PRIVATE");
    } finally {
      first.dispose();
      second.dispose();
    }
  },
);

test("submission cannot modify the immutable artifact cache", async () => {
  const artifact = await importExecutorArtifact(helperBinary);
  const workspace = await createExecutorWorkspace();
  const tamperPath = path.join(path.dirname(artifact.path), `tamper-${crypto.randomUUID()}.txt`);
  try {
    const result = await executorClient.run({
      runId: `artifact_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: workspace.id,
      executableId: artifact.executableId,
      args: ["--test-write", tamperPath, "16"],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.submission,
        wallTimeMs: 2_000,
        memoryBytes: 128 * MiB,
      },
    });
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert.equal(fs.existsSync(tamperPath), false);
  } finally {
    workspace.dispose();
    fs.rmSync(tamperPath, { force: true });
  }
});

test(
  "managed Python AppContainer blocks private files, network, and child processes",
  {
    timeout: 30_000,
    skip: process.platform !== "win32" || !managedPython.ready,
  },
  async () => {
    const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-python-boundary-"));
    const secretPath = path.join(hostDirectory, "secret.txt");
    const escapePath = path.join(hostDirectory, "escape.txt");
    fs.writeFileSync(secretPath, "PRIVATE", "utf8");
    try {
      const read = await runManagedPython(["read", secretPath]);
      assert.equal(read.result.reason, "exited", JSON.stringify(read.result));
      assert.notEqual(read.result.exitCode, 0, read.stdout);
      assert.doesNotMatch(read.stdout, /SECURITY_ESCAPE/);

      const write = await runManagedPython(["write", escapePath]);
      assert.equal(write.result.reason, "exited", JSON.stringify(write.result));
      assert.notEqual(write.result.exitCode, 0, write.stdout);
      assert.equal(fs.existsSync(escapePath), false);

      const network = await runManagedPython(["network"]);
      assert.equal(network.result.reason, "exited", JSON.stringify(network.result));
      assert.notEqual(network.result.exitCode, 0, network.stdout);

      const child = await runManagedPython(["subprocess"]);
      assert.ok(
        child.result.reason === "process_limit"
          || (child.result.reason === "exited" && child.result.exitCode !== 0),
        JSON.stringify(child.result),
      );
      assert.doesNotMatch(child.stdout, /SECURITY_ESCAPE/);
    } finally {
      fs.rmSync(hostDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "managed Python checker-runtime blocks private files, network, and child processes",
  {
    timeout: 30_000,
    skip: !managedPython.ready,
  },
  async () => {
    const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-checker-boundary-"));
    const secretPath = path.join(hostDirectory, "secret.txt");
    fs.writeFileSync(secretPath, "PRIVATE", "utf8");
    try {
      const read = await runManagedPython(["read", secretPath], "checker-runtime");
      assert.equal(read.result.reason, "exited", JSON.stringify(read.result));
      assert.notEqual(read.result.exitCode, 0, read.stdout);
      assert.doesNotMatch(read.stdout, /SECURITY_ESCAPE/);

      const network = await runManagedPython(["network"], "checker-runtime");
      assert.equal(network.result.reason, "exited", JSON.stringify(network.result));
      assert.notEqual(network.result.exitCode, 0, network.stdout);

      const child = await runManagedPython(["subprocess"], "checker-runtime");
      assert.ok(
        child.result.reason === "process_limit"
          || (child.result.reason === "exited" && child.result.exitCode !== 0),
        JSON.stringify(child.result),
      );
      assert.doesNotMatch(child.stdout, /SECURITY_ESCAPE/);
    } finally {
      fs.rmSync(hostDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "macOS checker-runtime denies exec of a sibling file in the certified package",
  {
    timeout: 10_000,
    skip: process.platform !== "darwin" || !managedPython.ready,
  },
  async () => {
    const runtime = await prepareIsolatedPythonRuntime(undefined, managedPython);
    const packageRoot = path.dirname(path.dirname(runtime.executablePath));
    const libraryDirectory = path.join(packageRoot, "lib");
    const siblingName = fs.readdirSync(libraryDirectory)
      .find((name) => /^libpython.+\.dylib$/.test(name));
    assert.ok(siblingName, `No sibling Mach-O library found in ${libraryDirectory}`);
    const siblingPath = path.join(libraryDirectory, siblingName);
    assert.notEqual(fs.realpathSync(siblingPath), fs.realpathSync(runtime.executablePath));

    const attempt = await runManagedPython(["exec", siblingPath], "checker-runtime");
    assert.equal(attempt.result.reason, "exited", JSON.stringify(attempt.result));
    assert.equal(attempt.result.exitCode, 13, attempt.stdout);
    assert.match(attempt.stdout, /^EXEC_ERRNO=1$/m);
  },
);

test(
  "native checker role blocks private files and network without spawning children",
  { timeout: 10_000 },
  async () => {
    const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-native-checker-boundary-"));
    const secretPath = path.join(hostDirectory, "secret.txt");
    fs.writeFileSync(secretPath, "PRIVATE", "utf8");
    try {
      const { result, stdout, stderr } = await runNativeChecker([
        "--test-file-network-probe",
        secretPath,
      ]);
      const diagnostic = JSON.stringify({ result, stdout, stderr });
      assert.equal(result.reason, "exited", diagnostic);
      assert.equal(result.exitCode, 0, diagnostic);
      const probe = JSON.parse(stdout) as Record<string, unknown>;
      assert.equal(probe.readBlocked, true, stdout);
      assert.equal(probe.writeBlocked, true, stdout);
      assert.equal(probe.networkBlocked, true, stdout);
      assert.equal(fs.readFileSync(secretPath, "utf8"), "PRIVATE");
    } finally {
      fs.rmSync(hostDirectory, { recursive: true, force: true });
    }
  },
);

test("native checker role contains child process attempts", { timeout: 10_000 }, async () => {
  const { result } = await runNativeChecker(
    ["--test-process-bomb", "128", "500"],
    { wallTimeMs: 2_000 },
  );
  assert.equal(result.reason, "process_limit", JSON.stringify(result));
});

test("wall-clock boundary matrix is stable across 20 repetitions", { timeout: 120_000 }, async () => {
  // LPAC/Seatbelt loader time is part of wall time, so calibrate it once and choose payloads whose
  // total observed workload targets 80/120% of the configured boundary.
  // A two-second window preserves the same ratios while keeping a transient 200 ms scheduler,
  // Defender, or remote-desktop pause from consuming the complete under-limit margin.
  const limitMs = 2_000;
  const baseline = await runHelper(["--test-sleep-ms", "0"], { wallTimeMs: 4_000 });
  assert.equal(baseline.reason, "exited");
  const loaderMs = baseline.wallTimeUs / 1000;
  const underPayloadMs = Math.max(1, Math.floor(limitMs * 0.8 - loaderMs));
  const overPayloadMs = Math.max(1, Math.ceil(limitMs * 1.2 - loaderMs));
  for (let index = 0; index < 20; index += 1) {
    const result = await runHelper(["--test-sleep-ms", String(underPayloadMs)], { wallTimeMs: limitMs });
    assert.equal(result.reason, "exited", `80% repetition ${index}: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
  }
  const elapsed: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const result = await runHelper(["--test-sleep-ms", String(overPayloadMs)], { wallTimeMs: limitMs });
    assert.equal(result.reason, "wall_time_limit", `120% repetition ${index}: ${JSON.stringify(result)}`);
    assert.ok(result.wallTimeUs >= (limitMs - 10) * 1000, `killed too early: ${result.wallTimeUs}us`);
    elapsed.push(result.wallTimeUs / 1000);
  }
  elapsed.sort((left, right) => left - right);
  const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1];
  assert.ok(p95 <= limitMs + Math.max(50, limitMs * 0.05), `p95 deadline lateness was ${p95 - limitMs}ms`);
});

test("CPU loop and sleep both receive TLE", { timeout: 10_000 }, async () => {
  const cpu = await runHelper(["--test-cpu-loop"], { wallTimeMs: 100 });
  const sleep = await runHelper(["--test-sleep-ms", "500"], { wallTimeMs: 100 });
  assert.equal(cpu.reason, "wall_time_limit");
  assert.equal(sleep.reason, "wall_time_limit");
});

test("job-wide memory boundary is stable across 20 repetitions", { timeout: 120_000 }, async () => {
  for (let index = 0; index < 20; index += 1) {
    const pass = await runHelper(["--test-allocate-mib", "48", "5"], {
      memoryBytes: 64 * MiB,
      wallTimeMs: 5_000,
    });
    assert.equal(pass.reason, "exited", `under-limit repetition ${index}: ${JSON.stringify(pass)}`);
  }
  for (let index = 0; index < 20; index += 1) {
    const fail = await runHelper(["--test-allocate-mib", "80", "200"], {
      memoryBytes: 64 * MiB,
      wallTimeMs: 5_000,
    });
    assert.equal(fail.reason, "memory_limit", `over-limit repetition ${index}: ${JSON.stringify(fail)}`);
    assert.ok((fail.peakMemoryBytes ?? 0) > 0);
    assert.ok(
      (fail.peakMemoryBytes ?? 0) <= 64 * MiB,
      `reported MLE memory exceeded the configured limit: ${JSON.stringify(fail)}`,
    );
  }
});

test("output, workspace-write, and thread bombs get distinct reasons", { timeout: 20_000 }, async () => {
  const output = await runHelper(["--test-output-bytes", String(2 * MiB)], {
    outputBytes: 64 * 1024,
    totalWriteBytes: 2 * MiB,
  });
  assert.equal(output.reason, "output_limit");

  for (let index = 0; index < 20; index += 1) {
    const written = await runHelperWithWorkspace(
      (workspacePath) => ["--test-write", path.join(workspacePath, "bomb.bin"), String(2 * MiB)],
      { outputBytes: 32 * 1024, totalWriteBytes: 64 * 1024 },
    );
    assert.equal(written.reason, "write_limit", `write-limit repetition ${index}: ${JSON.stringify(written)}`);
  }

  const threads = await runHelper(["--test-thread-bomb", "32", "1000"], { threadCount: 8 });
  assert.equal(threads.reason, "thread_limit");
});

test("kernel process ceiling contains a real process bomb", { timeout: 30_000 }, async () => {
  for (let index = 0; index < 20; index += 1) {
    const processes = await runHelper(["--test-process-bomb", "128", "500"], {
      processCount: 1,
      wallTimeMs: 2_000,
    });
    assert.equal(
      processes.reason,
      "process_limit",
      `process-limit repetition ${index}: ${JSON.stringify(processes)}`,
    );
  }
});

test("explicit cancellation kills the whole active run", { timeout: 10_000 }, async () => {
  const workspace = await createExecutorWorkspace();
  try {
    const executableName = process.platform === "win32" ? "fixture.exe" : "fixture";
    workspace.stage(helperBinary, executableName, true);
    const runId = `cancel_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const pending = executorClient.run({
      runId,
      role: "security-probe",
      workspaceId: workspace.id,
      executableId: workspace.relative(executableName),
      args: ["--test-sleep-ms", "5000"],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: limits({ wallTimeMs: 6000 }),
    });
    let terminalResultReceived = false;
    void pending.then(() => {
      terminalResultReceived = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await executorClient.cancel(runId), true);
    assert.equal(
      terminalResultReceived,
      true,
      "cancel acknowledged before the terminal run result/drain barrier",
    );
    assert.equal((await pending).reason, "cancelled");
  } finally {
    workspace.dispose();
  }
});

test(
  "checker-runtime cancellation acknowledges only after its terminal drain",
  {
    timeout: 10_000,
    skip: !managedPython.ready,
  },
  async () => {
    const workspace = await createExecutorWorkspace();
    try {
      const launch = await prepareIsolatedPythonScript(
        workspace,
        path.join(process.cwd(), "server/security-fixtures/python/resource_attacks.py"),
        "checker_cancel.py",
        undefined,
        managedPython,
      );
      const runId = `checker_cancel_${crypto.randomUUID().replaceAll("-", "_")}`;
      const pending = executorClient.run(buildCheckerExecutorRunSpec({
        runId,
        workspaceId: workspace.id,
        executableId: launch.executableId,
        args: [...launch.args, "sleep-ms", "5000"],
        stdoutFile: "stdout.txt",
        stderrFile: "stderr.txt",
        environment: launch.environment,
        runtimeBacked: true,
        timeoutMs: 6_000,
        memoryBytes: 128 * MiB,
        toolchain: launch.toolchain,
      }));
      let terminalResultReceived = false;
      void pending.then(() => {
        terminalResultReceived = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(await executorClient.cancel(runId), true);
      assert.equal(terminalResultReceived, true);
      assert.ok(
        ["cancelled", "launch_error"].includes((await pending).reason),
        `unexpected termination reason: ${(await pending).reason}`,
      );
    } finally {
      workspace.dispose();
    }
  },
);

async function runHelper(
  args: string[],
  overrides: Partial<ExecutorLimits> = {},
): Promise<ExecutorRunResult> {
  return runHelperWithWorkspace(() => args, overrides);
}

async function runManagedPython(
  args: string[],
  role: "submission" | "checker-runtime" = "submission",
): Promise<{ result: ExecutorRunResult; stdout: string }> {
  const workspace = await createExecutorWorkspace();
  try {
    const launch = await prepareIsolatedPythonScript(
      workspace,
      path.join(process.cwd(), "server/security-fixtures/python/resource_attacks.py"),
      "resource_attacks.py",
      undefined,
      managedPython,
    );
    const runId = `python_security_${crypto.randomUUID().replaceAll("-", "_")}`;
    const common = {
      runId,
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: [...launch.args, ...args],
      environment: launch.environment,
      memoryBytes: 128 * MiB,
      toolchain: launch.toolchain,
    };
    const result = await executorClient.run(
      role === "checker-runtime"
        ? buildCheckerExecutorRunSpec({
            ...common,
            runtimeBacked: true,
            timeoutMs: 2_000,
            stdoutFile: "stdout.txt",
            stderrFile: "stderr.txt",
          })
        : buildSubmissionExecutorRunSpec({
            ...common,
            timeLimitMs: 2_000,
          }),
    );
    return {
      result,
      stdout: fs.existsSync(path.join(workspace.path, "stdout.txt"))
        ? fs.readFileSync(path.join(workspace.path, "stdout.txt"), "utf8")
        : "",
    };
  } finally {
    workspace.dispose();
  }
}

async function runNativeChecker(
  args: string[],
  overrides: Partial<ExecutorLimits> = {},
): Promise<{ result: ExecutorRunResult; stdout: string; stderr: string }> {
  const workspace = await createExecutorWorkspace();
  try {
    const executableName = process.platform === "win32" ? "checker.exe" : "checker";
    workspace.stage(helperBinary, executableName, true);
    const result = await executorClient.run({
      runId: `native_checker_security_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "checker",
      workspaceId: workspace.id,
      executableId: workspace.relative(executableName),
      args,
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.checker,
        wallTimeMs: 2_000,
        memoryBytes: 128 * MiB,
        processCount: 1,
        ...overrides,
      },
    });
    const stdoutPath = path.join(workspace.path, "stdout.txt");
    const stderrPath = path.join(workspace.path, "stderr.txt");
    return {
      result,
      stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8").trim() : "",
      stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8").trim() : "",
    };
  } finally {
    workspace.dispose();
  }
}

async function runHelperWithWorkspace(
  args: (workspacePath: string) => string[],
  overrides: Partial<ExecutorLimits> = {},
): Promise<ExecutorRunResult> {
  const workspace = await createExecutorWorkspace();
  try {
    const executableName = process.platform === "win32" ? "fixture.exe" : "fixture";
    workspace.stage(helperBinary, executableName, true);
    return await executorClient.run({
      runId: `fixture_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role: "security-probe",
      workspaceId: workspace.id,
      executableId: workspace.relative(executableName),
      args: args(workspace.path),
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: limits(overrides),
    });
  } finally {
    workspace.dispose();
  }
}

function limits(overrides: Partial<ExecutorLimits>): ExecutorLimits {
  return {
    ...DEFAULT_EXECUTOR_LIMITS.submission,
    wallTimeMs: 2000,
    memoryBytes: 128 * MiB,
    ...overrides,
  };
}
