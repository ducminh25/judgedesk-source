import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadPreferences,
  savePreferences,
  getToolchainsDir,
} from "./storage.js";
import {
  chooseNativeProtectedToolchain,
  compareVersions,
  executableVersionArguments,
  buildCompilerProbeArgs,
  buildDarwinSdkCandidates,
  buildSelectedDarwinCompilerCandidates,
  buildSelectedDarwinCppCandidates,
  buildToolchainEnvironment,
  inferDarwinDeveloperRoot,
  isPythonCheckerReady,
  isPythonSubmissionReady,
  isDarwinAppleToolchainLocation,
  isDarwinSandboxCompatibleCpp,
  managedPackageVersionMatches,
  MIN_GNU_CPP_VERSION,
  MIN_GNU_GDB_VERSION,
  verifyLocalToolchainCandidate,
} from "./resolver.js";

test("receipt-backed managed packages must match their exact catalog version", () => {
  assert.equal(
    managedPackageVersionMatches("java", "21.0.12", "21.0.12+8"),
    true,
  );
  assert.equal(
    managedPackageVersionMatches("java", "25.0.3", "21.0.12+8"),
    false,
  );
  assert.equal(
    managedPackageVersionMatches("javascript", "24.18.1", "24.18.1"),
    true,
  );
  assert.equal(
    managedPackageVersionMatches("rust", "1.97.0", "1.97.1"),
    false,
  );
});

test("macOS native protection rejects non-Apple compiler locations", () => {
  assert.equal(isDarwinSandboxCompatibleCpp("/opt/homebrew/bin/g++-14"), false);
  assert.equal(isDarwinSandboxCompatibleCpp("/opt/homebrew/opt/llvm/bin/clang++"), false);
  assert.equal(isDarwinSandboxCompatibleCpp("/usr/local/bin/g++"), false);
  assert.equal(isDarwinSandboxCompatibleCpp("/path/that/does/not/exist/clang++"), false);
});

test("macOS resolves the real compiler inside the selected Developer root", () => {
  assert.deepEqual(
    buildSelectedDarwinCppCandidates("/Library/Developer/CommandLineTools"),
    [
      "/Library/Developer/CommandLineTools/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++",
      "/Library/Developer/CommandLineTools/usr/bin/clang++",
    ],
  );
  assert.deepEqual(
    buildSelectedDarwinCppCandidates("/Applications/Xcode.app/Contents/Developer"),
    [
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++",
      "/Applications/Xcode.app/Contents/Developer/usr/bin/clang++",
    ],
  );
  assert.deepEqual(
    buildSelectedDarwinCompilerCandidates(
      "/Library/Developer/CommandLineTools",
      "c",
    ),
    [
      "/Library/Developer/CommandLineTools/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
      "/Library/Developer/CommandLineTools/usr/bin/clang",
    ],
  );
  assert.equal(
    isDarwinAppleToolchainLocation(
      "/Applications/Xcode-beta.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
    ),
    true,
  );
  assert.equal(
    isDarwinAppleToolchainLocation(
      "/Library/Developer/CommandLineTools/usr/bin/clang",
    ),
    true,
  );
  assert.equal(isDarwinAppleToolchainLocation("/usr/bin/clang"), false);
  assert.equal(isDarwinAppleToolchainLocation("/opt/homebrew/bin/clang++"), false);
  assert.equal(
    inferDarwinDeveloperRoot(
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
    ),
    "/Applications/Xcode.app/Contents/Developer",
  );
  assert.equal(
    inferDarwinDeveloperRoot(
      "/Library/Developer/CommandLineTools/usr/bin/clang",
    ),
    "/Library/Developer/CommandLineTools",
  );
  assert.deepEqual(
    buildDarwinSdkCandidates("/Applications/Xcode.app/Contents/Developer"),
    [
      "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
      "/Applications/Xcode.app/Contents/Developer/SDKs/MacOSX.sdk",
    ],
  );
});

test("native protection preserves explicit C++ source intent without fallback", () => {
  const managed = {
    kind: "cpp" as const,
    source: "managed" as const,
    executablePath: String.raw`C:\managed\g++.exe`,
    version: "14.2.0",
    ready: true,
  };
  const system = {
    kind: "cpp" as const,
    source: "system" as const,
    executablePath: String.raw`C:\system\g++.exe`,
    version: "16.1.0",
    ready: true,
  };
  assert.deepEqual(
    chooseNativeProtectedToolchain("win32", "cpp", managed, system),
    {
      ...system,
      ready: false,
      diagnostic:
        "The selected local C++ compiler has not been certified for the Windows secure runner.",
      diagnosticCode: "CERTIFICATION_REQUIRED",
    },
  );
  assert.equal(chooseNativeProtectedToolchain("darwin", "cpp", managed, system), system);
  assert.equal(
    chooseNativeProtectedToolchain("win32", "cpp", managed, managed),
    managed,
  );
  const certified = {
    ...system,
    provenance: "certified-local" as const,
    certificateId: `cert_${"a".repeat(64)}`,
    executionPath: String.raw`C:\executor\toolchains\local_cpp\payload\bin\g++.exe`,
    executionId: "toolchains/local_cpp/payload/bin/g++.exe",
    snapshotDigest: "b".repeat(64),
    certifiedRoles: ["submission", "checker"] as const,
  };
  assert.equal(
    chooseNativeProtectedToolchain("win32", "cpp", managed, certified),
    certified,
  );
  assert.deepEqual(
    chooseNativeProtectedToolchain("win32", "cpp", { ...managed, ready: false }, system),
    {
      ...system,
      ready: false,
      diagnostic:
        "The selected local C++ compiler has not been certified for the Windows secure runner.",
      diagnosticCode: "CERTIFICATION_REQUIRED",
    },
  );
});

test("native protection honors the active Python source", () => {
  const managed = {
    kind: "python" as const,
    source: "managed" as const,
    executablePath: "/managed/bin/python3",
    version: "3.12.13",
    ready: true,
  };
  const system = {
    kind: "python" as const,
    source: "system" as const,
    executablePath: "/usr/bin/python3",
    version: "3.9.6",
    ready: true,
  };
  assert.equal(chooseNativeProtectedToolchain("darwin", "python", managed, system), system);
  assert.equal(chooseNativeProtectedToolchain("win32", "python", managed, system), system);
  assert.equal(chooseNativeProtectedToolchain("darwin", "python", { ...managed, ready: false }, system), system);
});

test("unmanaged Python is neither submission- nor checker-ready without certification", () => {
  const managed = {
    kind: "python" as const,
    source: "managed" as const,
    executablePath: "/managed/bin/python3",
    version: "3.12.13",
    ready: true,
  };
  const system = {
    kind: "python" as const,
    source: "system" as const,
    executablePath: "/usr/bin/python3",
    version: "3.9.6",
    ready: true,
  };

  assert.equal(isPythonSubmissionReady(managed), true);
  assert.equal(isPythonSubmissionReady({ ...managed, ready: false }), false);
  assert.equal(isPythonSubmissionReady(system), false);
  assert.equal(isPythonCheckerReady(managed), true);
  assert.equal(isPythonCheckerReady({ ...managed, ready: false }), false);
  assert.equal(isPythonCheckerReady(system), false);
});

test("toolchain environment prepends the detected executable directory", () => {
  const environment = buildToolchainEnvironment(
    "D:\\Portable Themis\\GCC\\bin\\g++.exe",
    { Path: "C:\\Windows\\System32;C:\\Windows" },
    "win32",
  );
  assert.equal(
    environment.Path,
    "D:\\Portable Themis\\GCC\\bin;C:\\Windows\\System32;C:\\Windows",
  );

  const unchanged = buildToolchainEnvironment(
    "D:\\Portable Themis\\GCC\\bin\\g++.exe",
    environment,
    "win32",
  );
  assert.equal(unchanged.Path, environment.Path);
});

test("toolchain version floors match the supported Themis bundle", () => {
  assert.equal(MIN_GNU_CPP_VERSION, "9.2.0");
  assert.equal(MIN_GNU_GDB_VERSION, "7.6.1");
  assert.equal(compareVersions("9.2.0", MIN_GNU_CPP_VERSION), 0);
  assert.ok(compareVersions("9.1.9", MIN_GNU_CPP_VERSION) < 0);
  assert.ok(compareVersions("14.2", MIN_GNU_CPP_VERSION) > 0);
  assert.equal(compareVersions("7.6.1", MIN_GNU_GDB_VERSION), 0);
  assert.ok(compareVersions("7.6.0", MIN_GNU_GDB_VERSION) < 0);
});

test("compiler probe uses production-compatible flags on Windows and macOS", () => {
  const windows = buildCompilerProbeArgs("win32", "probe.cpp", "probe.exe");
  assert.ok(windows.includes("-static"));
  assert.equal(windows.some((flag) => flag.startsWith("-fsanitize")), false);
  assert.ok(windows.includes("-s"));
  assert.ok(windows.includes("-Wl,--stack,66060288"));
  assert.equal(windows.at(-3), "probe.cpp");

  const mac = buildCompilerProbeArgs(
    "darwin",
    "probe.cpp",
    "probe",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
  );
  assert.equal(mac.includes("-static"), false);
  assert.equal(mac.includes("-lm"), false);
  assert.equal(mac.includes("-s"), false);
  assert.deepEqual(
    mac.slice(mac.indexOf("-isysroot"), mac.indexOf("-isysroot") + 2),
    [
      "-isysroot",
      "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    ],
  );
  assert.equal(mac.some((flag) => flag.includes("--stack")), false);
  assert.equal(mac.at(-3), "probe.cpp");
  assert.throws(
    () => buildCompilerProbeArgs("darwin", "probe.cpp", "probe"),
    /macOS SDK was not found/,
  );
});

test("legacy v1 preferences round-trip independent C++ and Python selections", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-storage-test-"),
  );
  const previousAppDataDir = process.env.THEMIS_APP_DATA_DIR;
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousAppDataDir === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previousAppDataDir;
  });
  process.env.THEMIS_APP_DATA_DIR = tempDir;

  const initial = loadPreferences();
  assert.equal(initial.preferredSourceCpp, "system");
  assert.equal(initial.preferredSourcePython, "system");

  savePreferences({
    preferredSourceCpp: "custom",
    customCppPath: "C:\\mock\\g++.exe",
    preferredSourcePython: "managed",
    customPythonPath: "C:\\remembered\\python.exe",
    installedToolchains: ["gcc-windows-x64"],
  });

  const loaded = loadPreferences();
  assert.equal(loaded.preferredSourceCpp, "custom");
  assert.equal(loaded.customCppPath, "C:\\mock\\g++.exe");
  assert.equal(loaded.preferredSourcePython, "managed");
  assert.equal(loaded.customPythonPath, "C:\\remembered\\python.exe");
  assert.deepEqual(loaded.installedToolchains, []);
});

test("version probes use each toolchain's real non-shell CLI contract", () => {
  assert.deepEqual(executableVersionArguments("go"), ["version"]);
  assert.deepEqual(executableVersionArguments("pascal"), ["-iV"]);
  assert.deepEqual(executableVersionArguments("java"), ["--version"]);
  assert.deepEqual(executableVersionArguments("javascript"), ["--version"]);
});

test("quick verification rejects a real but untested local runtime version", () => {
  const result = verifyLocalToolchainCandidate(
    "javascript",
    process.execPath,
  );
  assert.equal(result.ready, false);
  assert.equal(result.diagnosticCode, "LOCAL_VERSION_UNSUPPORTED");
  assert.match(result.version, /^\d+\.\d+\.\d+$/);
});

test("toolchainsDir resolves and creates directories", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-storage-test-"),
  );
  const previousAppDataDir = process.env.THEMIS_APP_DATA_DIR;
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousAppDataDir === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previousAppDataDir;
  });
  process.env.THEMIS_APP_DATA_DIR = tempDir;

  const toolchainsDir = getToolchainsDir();
  assert.ok(fs.existsSync(toolchainsDir));
  assert.ok(toolchainsDir.endsWith("toolchains"));
});
