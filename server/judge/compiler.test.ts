import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

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
    assert.equal(process.env.JUDGEDESK_TREE_GUARD_REQUIRED, "1");
    return null;
  }
  assert.equal(present.length, 0, `partial macOS process-tree guard environment: ${present.join(", ")}`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-compiler-tree-guard-"));
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

const ownedMacosTreeGuard = provisionMacosTreeGuard();
const [{ executorClient }, {
  buildCompilerEnvironment,
  buildCustomCheckerCompilerArgs,
  buildCompilerPhases,
  buildSubmissionCompilerArgs,
  CHECKER_COMPILE_MEMORY_LIMIT_BYTES,
  CHECKER_COMPILE_TIMEOUT_MS,
  COMPILE_TIMEOUT_MS,
  findGccIncludeDirectories,
  MAX_GENERATED_FILE_BYTES,
  resolveChecker,
  resolveDarwinCompatibilityHeader,
  runCompilerWithLimits,
  stagedCompilerName,
}, { runCustomChecker }] = await Promise.all([
  import("../executor/client.js"),
  import("./compiler.js"),
  import("./custom-checker-runner.js"),
]);

after(async () => {
  await executorClient.shutdown();
  if (ownedMacosTreeGuard) {
    fs.rmSync(ownedMacosTreeGuard.directory, { recursive: true });
  }
});

test("compiler request uses a minimal environment independent of the parent shell", () => {
  assert.deepEqual(
    buildCompilerEnvironment("D:\\Managed GCC\\bin\\g++.exe", "win32"),
    { PATH: "D:\\Managed GCC\\bin", TMPDIR: "." },
  );
  assert.deepEqual(buildCompilerEnvironment("/usr/bin/clang++", "darwin"), {});
});

test("macOS staging preserves the resolved Apple Clang binary name for cc1 re-exec", () => {
  assert.equal(stagedCompilerName("/toolchain/bin/clang", "darwin"), "clang");
  assert.equal(stagedCompilerName(String.raw`C:\toolchain\bin\g++.exe`, "win32"), "compiler.exe");
});

test("macOS resolves only a regular packaged bits/stdc++.h compatibility header", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-compat-header-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const header = path.join(root, "compiler-compat", "include", "bits", "stdc++.h");
  fs.mkdirSync(path.dirname(header), { recursive: true });
  fs.writeFileSync(header, "#include <vector>\n", "utf8");

  assert.equal(resolveDarwinCompatibilityHeader(root), fs.realpathSync(header));
  fs.rmSync(header);
  assert.throws(
    () => resolveDarwinCompatibilityHeader(root),
    /compatibility headers were not found/,
  );
});

test("native compilation separates the compiler frontend from the linker", () => {
  const output = path.resolve("program.out");
  const object = path.resolve("program.o");
  const source = path.resolve("main.cpp");
  const phases = buildCompilerPhases(
    [
      "-std=c++14",
      "-O2",
      "-fsanitize=integer-divide-by-zero",
      "-fsanitize-trap=integer-divide-by-zero",
      "-s",
      "-static",
      "-lm",
      "-x",
      "c++",
      source,
      "-o",
      output,
    ],
    output,
    object,
  );
  assert.deepEqual(
    phases.compile,
    [
      "-std=c++14",
      "-O2",
      "-fsanitize=integer-divide-by-zero",
      "-fsanitize-trap=integer-divide-by-zero",
      "-x",
      "c++",
      source,
      "-c",
      "-o",
      object,
    ],
  );
  assert.deepEqual(
    phases.link,
    [object, "-o", output, "-s", "-static", "-lm"],
  );
});

test("relocated managed GCC discovers only cache-contained system include directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-gcc-includes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = [
    path.join(root, "include", "c++", "14.2.0"),
    path.join(root, "include", "c++", "14.2.0", "x86_64-w64-mingw32", "bits"),
    path.join(root, "include", "c++", "14.2.0", "backward"),
    path.join(root, "lib", "gcc", "x86_64-w64-mingw32", "14.2.0", "include"),
    path.join(root, "x86_64-w64-mingw32", "include"),
  ];
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directories[0], "iostream"), "");
  fs.writeFileSync(path.join(directories[1], "c++config.h"), "");
  fs.writeFileSync(path.join(directories[3], "stddef.h"), "");
  fs.writeFileSync(path.join(directories[4], "windows.h"), "");

  const found = findGccIncludeDirectories(root).map((directory) => path.resolve(directory));
  for (const expected of [directories[0], path.dirname(directories[1]), directories[2], directories[3], directories[4]]) {
    assert.ok(found.includes(path.resolve(expected)), `missing ${expected}`);
  }
  assert.ok(found.every((directory) => path.relative(root, directory) && !path.relative(root, directory).startsWith("..")));
});

test("relocated MSYS2 UCRT64 GCC accepts its root include directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-msys2-gcc-includes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cppRoot = path.join(root, "include", "c++", "16.1.0");
  const cppTargetBits = path.join(cppRoot, "x86_64-w64-mingw32", "bits");
  const gccInclude = path.join(root, "lib", "gcc", "x86_64-w64-mingw32", "16.1.0", "include");
  const runtimeInclude = path.join(root, "include");
  for (const directory of [cppRoot, cppTargetBits, gccInclude, runtimeInclude]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(cppRoot, "iostream"), "");
  fs.writeFileSync(path.join(cppTargetBits, "c++config.h"), "");
  fs.writeFileSync(path.join(gccInclude, "stddef.h"), "");
  fs.writeFileSync(path.join(runtimeInclude, "windows.h"), "");

  const found = findGccIncludeDirectories(root).map((directory) => path.resolve(directory));
  for (const expected of [cppRoot, path.dirname(cppTargetBits), gccInclude, runtimeInclude]) {
    assert.ok(found.includes(path.resolve(expected)), `missing ${expected}`);
  }
  assert.ok(found.every((directory) => {
    const relative = path.relative(root, directory);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }));
});

function executorTestHelper(): string {
  const target = process.platform === "win32"
    ? "judgedesk-executor-x86_64-pc-windows-msvc.exe"
    : process.arch === "arm64"
      ? "judgedesk-executor-aarch64-apple-darwin"
      : "judgedesk-executor-x86_64-apple-darwin";
  return path.join(process.cwd(), "src-tauri", "binaries", target);
}

const fakeCompilerHarnessSkip = process.platform === "win32"
  ? false
  : "the fake compiler is intentionally rejected by macOS; release tests cover Seatbelt limits and real Apple Clang separately";

test("submission and custom-checker compiler limits are explicit", () => {
  assert.equal(COMPILE_TIMEOUT_MS, 15_000);
  assert.equal(MAX_GENERATED_FILE_BYTES, 32 * 1024 * 1024);
  assert.equal(CHECKER_COMPILE_TIMEOUT_MS, 60_000);
  assert.equal(CHECKER_COMPILE_MEMORY_LIMIT_BYTES, 768 * 1024 * 1024);
});

test("compiler watchdog terminates a stuck compiler", { skip: fakeCompilerHarnessSkip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-compiler-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runCompilerWithLimits(
      executorTestHelper(),
      ["--test-sleep"],
      root,
      path.join(root, "never-created.out"),
      undefined,
      { timeoutMs: 100, maxGeneratedFileBytes: 64 * 1024 },
    ),
    /COMPILER_TIMEOUT/,
  );
});

test("compiler rejects and removes an oversized generated file", { skip: fakeCompilerHarnessSkip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-compiler-size-"));
  const outputPath = path.join(root, "oversized.out");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runCompilerWithLimits(
      executorTestHelper(),
      [
        "--test-write",
        outputPath,
        "131072",
      ],
      root,
      outputPath,
      undefined,
      { timeoutMs: 2_000, maxGeneratedFileBytes: 64 * 1024 },
    ),
    /GENERATED_FILE_TOO_LARGE/,
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test("compiler flags retain Windows limits and avoid unsupported macOS flags", () => {
  const windows = buildSubmissionCompilerArgs(
    "win32",
    "source file.cpp",
    "output file.exe",
  );
  assert.deepEqual(windows, [
    "-std=c++14",
    "-pipe",
    "-O2",
    "-s",
    "-static",
    "-lm",
    "-x",
    "c++",
    "-Wl,--stack,66060288",
    "source file.cpp",
    "-o",
    "output file.exe",
  ]);

  const mac = buildSubmissionCompilerArgs("darwin", "main.cpp", "main");
  assert.equal(mac.includes("-static"), false);
  assert.equal(mac.includes("-lm"), false);
  assert.equal(mac.includes("-s"), false);
  assert.equal(mac.some((flag) => flag.startsWith("-fsanitize")), false);
  assert.equal(
    mac.some((flag) => flag.includes("--stack")),
    false,
  );

  const linux = buildSubmissionCompilerArgs("linux", "main.cpp", "main");
  assert.ok(linux.includes("-static"));
  assert.equal(linux.some((flag) => flag.includes("integer-divide-by-zero")), false);
  assert.equal(
    linux.some((flag) => flag.includes("--stack")),
    false,
  );

  const cWindows = buildSubmissionCompilerArgs(
    "win32",
    "main.c",
    "main.exe",
    "c",
  );
  assert.deepEqual(cWindows, [
    "-std=c11",
    "-pipe",
    "-O2",
    "-s",
    "-static",
    "-lm",
    "-x",
    "c",
    "-Wl,--stack,66060288",
    "main.c",
    "-o",
    "main.exe",
  ]);
});

test("standard checkers use the cross-platform built-in implementation", async () => {
  assert.deepEqual(
    await resolveChecker({
      checkerType: "C1",
      problemName: "sample",
      problemDirectory: ".",
      tempDirectory: ".",
    }),
    { path: null },
  );
});

test("Windows custom C++ checkers use a self-contained linker policy", () => {
  const windows = buildCustomCheckerCompilerArgs(
    "win32",
    "checker support",
    "checker source.cpp",
    "checker output.exe",
  );
  assert.ok(windows.includes("-static"));
  assert.ok(windows.includes("-s"));
  assert.ok(windows.includes("-lm"));
  assert.ok(windows.includes("-Wl,--stack,66060288"));
  assert.ok(windows.includes("checker support"));
  assert.ok(windows.includes("checker source.cpp"));

  const mac = buildCustomCheckerCompilerArgs("darwin", "include", "checker.cpp", "checker");
  assert.equal(mac.includes("-static"), false);
  assert.equal(mac.includes("-s"), false);
  assert.equal(mac.includes("-lm"), false);
});

test("custom checker resolution accepts source files and rejects executables", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-checker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(
    path.join(process.cwd(), "server/security-fixtures/cpp/checker_smoke.cpp"),
    path.join(root, "checker.cpp"),
  );
  fs.writeFileSync(path.join(root, "checker.py"), "raise SystemExit(0)\n", "utf8");

  if (process.platform === "win32" || process.platform === "darwin") {
    const cppChecker = await resolveChecker({
      checkerType: "checker.cpp",
      problemName: "sample",
      problemDirectory: root,
      tempDirectory: root,
    });
    if (cppChecker.error) {
      assert.equal(cppChecker.error, "TOOLCHAIN_CPP_MISSING");
    } else {
      assert.equal(cppChecker.runtime, "native");
      assert.ok(cppChecker.path && fs.existsSync(cppChecker.path));
      const inputPath = path.join(root, "input.txt");
      const actualOutputPath = path.join(root, "actual.txt");
      const expectedOutputPath = path.join(root, "expected.txt");
      fs.writeFileSync(inputPath, "1\n", "utf8");
      fs.writeFileSync(actualOutputPath, "1\n", "utf8");
      fs.writeFileSync(expectedOutputPath, "1\n", "utf8");
      const result = await runCustomChecker({
        checkerPath: cppChecker.path,
        checkerRuntime: "native",
        inputPath,
        actualOutputPath,
        expectedOutputPath,
        maxScore: 10,
      });
      assert.equal(result.status, "AC", JSON.stringify(result));
      assert.equal(result.score, 10);
    }
  }

  const pythonChecker = await resolveChecker({
    checkerType: "checker.py",
    problemName: "sample",
    problemDirectory: root,
    tempDirectory: root,
  });
  if (pythonChecker.error) {
    assert.ok(
      pythonChecker.error ===
        "CHECKER_TOOLCHAIN_UNAVAILABLE: cannot compile Python checker; Python is missing"
        || pythonChecker.error.startsWith("CHECKER_TOOLCHAIN_MANAGED_REQUIRED:"),
      pythonChecker.error,
    );
  } else {
    assert.equal(pythonChecker.path, path.join(root, "checker.py"));
    assert.equal(pythonChecker.runtime, "python");
    assert.ok(pythonChecker.pythonExecutablePath);
  }
  assert.match(
    (await resolveChecker({
      checkerType: "checker.exe",
      problemName: "sample",
      problemDirectory: root,
      tempDirectory: root,
    })).error || "",
    /not supported.*\.cpp or \.py/i,
  );

  if (!pythonChecker.error) {
    fs.writeFileSync(path.join(root, "broken.py"), "def broken(:\n", "utf8");
    assert.match(
      (await resolveChecker({
        checkerType: "broken.py",
        problemName: "sample",
        problemDirectory: root,
        tempDirectory: root,
      })).error || "",
      /^PYTHON_CHECKER_COMPILE_ERROR:/,
    );
  }
});
