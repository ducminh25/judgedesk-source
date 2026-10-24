import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCompileConfig,
  createCustomCompileConfig,
  normalizeCompileConfig,
  parseAndValidateCustomCompileFlags,
  validateCustomCompileFlags,
} from "../../shared/compile-config.js";
import {
  createDefaultProblemConfig,
  normalizeProblemConfig,
  reconcileStoredProblemConfig,
} from "../../shared/problem-config.js";
import {
  ensureOrReconcileStoredProblemConfig,
  readStoredProblemConfig,
  resolveProblemConfig,
  writeStoredProblemConfig,
} from "./problem-config-repository.js";

test("problem config retains supported decimal score spellings", () => {
  const config = normalizeProblemConfig("SUM", { defaultScore: ".5", totalScore: "1.", testScores: { "01": ".5" } });
  assert.equal(config.defaultScore, "0.5");
  assert.equal(config.totalScore, 1);
  assert.equal(config.testScores["01"], "0.5");

  const commaConfig = normalizeProblemConfig("SUM", { defaultScore: "0,5", totalScore: "2,5", testScores: { "01": "1,25" } });
  assert.equal(commaConfig.defaultScore, "0.5");
  assert.equal(commaConfig.totalScore, "2.5");
  assert.equal(commaConfig.testScores["01"], "1.25");
});

test("problem config defaults use the problem name and safe grading defaults", () => {
  assert.deepEqual(createDefaultProblemConfig("SUM"), {
    testWellFormed: false,
    useStdIO: false,
    useStdIn: false,
    useStdOut: false,
    inputFile: "SUM.inp",
    outputFile: "SUM.out",
    totalScore: null,
    defaultScore: 1,
    testScores: {},
    memoryLimit: 256,
    checkerType: "C1",
    compile: {
      schemaVersion: 1,
      profile: "themis",
      flags: {
        cpp: ["-std=c++14", "-O2", "-pipe"],
        c: ["-std=c11", "-O2", "-pipe"],
      },
    },
    polygonConfig: { enableGroups: false, tests: {}, groups: {} },
    isInteractive: false,
    interactor: "interactor.cpp",
  });
});

test("well-formed setting uses the saved value when present", () => {
  assert.equal(normalizeProblemConfig("SUM", { testWellFormed: true }).testWellFormed, true);
  assert.equal(normalizeProblemConfig("SUM", { testWellFormed: true }, { testWellFormed: false }).testWellFormed, false);
});

test("stored config overrides request config and legacy useStdIO is normalized", () => {
  const config = normalizeProblemConfig(
    "SUM",
    { useStdIO: false, defaultScore: 2, checkerType: "C2", testScores: { test01: 2 } },
    {
      useStdIO: true,
      defaultScore: 3,
      checkerType: "C3",
      testScores: { test02: 4 },
      enableGroups: true,
      tests: { test01: { points: 5, group: "A" } },
      groups: { A: { policy: "EACH_TEST", dependencies: [] } }
    }
  );

  assert.equal(config.useStdIn, true);
  assert.equal(config.useStdOut, true);
  assert.equal(config.defaultScore, 3);
  assert.equal(config.checkerType, "C3");
  assert.deepEqual(config.testScores, { test01: 2, test02: 4 });
  assert.equal(config.polygonConfig.enableGroups, true);
});

test("legacy problem configs without compile metadata normalize to a Themis snapshot", () => {
  const config = normalizeProblemConfig("SUM", { useStdIO: true }, null);
  assert.deepEqual(config.compile, createCompileConfig("themis"));
});

test("compile presets use versioned argv snapshots", () => {
  assert.deepEqual(createCompileConfig("modern_ioi_icpc_2025"), {
    schemaVersion: 1,
    profile: "modern_ioi_icpc_2025",
    flags: {
      cpp: ["-std=gnu++20", "-O2", "-pipe"],
      c: ["-std=gnu17", "-O2", "-pipe"],
    },
  });
  assert.deepEqual(createCompileConfig("icpc_world_finals"), {
    schemaVersion: 1,
    profile: "icpc_world_finals",
    flags: {
      cpp: ["-std=gnu++20", "-O2", "-g"],
      c: ["-std=gnu11", "-O2", "-g"],
    },
  });
});

test("stored compile snapshots override request presets without being regenerated", () => {
  const storedSnapshot = {
    schemaVersion: 1 as const,
    profile: "modern_ioi_icpc_2025" as const,
    flags: {
      cpp: ["-std=gnu++20", "-O1"],
      c: ["-std=gnu17", "-O1"],
    },
  };
  const config = normalizeProblemConfig(
    "SUM",
    { compile: createCompileConfig("icpc_world_finals") },
    { compile: storedSnapshot },
  );
  assert.deepEqual(config.compile, storedSnapshot);
  assert.notEqual(config.compile.flags.cpp, storedSnapshot.flags.cpp);
});

test("custom flag text is tokenized as argv without shell evaluation", () => {
  assert.deepEqual(
    parseAndValidateCustomCompileFlags(
      '-std=gnu++20 -O3 "-DPROBLEM_NAME=Đề số 1" -DVALUE=\"a;b\"',
    ),
    ["-std=gnu++20", "-O3", "-DPROBLEM_NAME=Đề số 1", "-DVALUE=a;b"],
  );
});

test("custom flags reject protected source, output, plugin, response, and toolchain arguments", () => {
  const forbidden = [
    "submission.cpp",
    "-o",
    "-x",
    "@flags.rsp",
    "-fplugin=C:/malicious.dll",
    "--sysroot=C:/other-toolchain",
    "-Iother/include",
    "-Wl,--stack,1",
  ];
  for (const token of forbidden) {
    assert.throws(
      () => validateCustomCompileFlags([token]),
      /INVALID_COMPILE_CONFIG/,
      token,
    );
  }
});

test("custom profiles require safe argv arrays for both C and C++", () => {
  assert.deepEqual(createCustomCompileConfig({
    cpp: ["-std=gnu++20", "-O3", "-Wall"],
    c: ["-std=gnu17", "-O3", "-Wall"],
  }), {
    schemaVersion: 1,
    profile: "custom",
    flags: {
      cpp: ["-std=gnu++20", "-O3", "-Wall"],
      c: ["-std=gnu17", "-O3", "-Wall"],
    },
  });
  assert.throws(
    () => normalizeCompileConfig({ schemaVersion: 1, profile: "custom" }),
    /custom profile requires cpp and c flag arrays/,
  );
});

test("Config.cfg writes a normalized compile snapshot and preserves later changes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-problem-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  writeStoredProblemConfig(directory, { useStdIO: false });
  assert.deepEqual(readStoredProblemConfig(directory)?.compile, createCompileConfig("themis"));

  const custom = createCustomCompileConfig({
    cpp: ["-std=gnu++20", "-O3"],
    c: ["-std=gnu17", "-O3"],
  });
  writeStoredProblemConfig(directory, { useStdIO: false, compile: custom });
  assert.deepEqual(readStoredProblemConfig(directory)?.compile, custom);
});

test("problem config normalizes memory limit between 8 MB and 1024 MB with default 256 MB", () => {
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: 2048 }).memoryLimit, 1024);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: 1024 }).memoryLimit, 1024);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: 512 }).memoryLimit, 512);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: 256 }).memoryLimit, 256);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: 4 }).memoryLimit, 8);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: 0 }).memoryLimit, 256);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: -100 }).memoryLimit, 256);
  assert.equal(normalizeProblemConfig("SUM", { memoryLimit: undefined }).memoryLimit, 256);
});

test("ensureOrReconcileStoredProblemConfig and resolveProblemConfig auto-select custom checker on first import and respect explicit checker selection", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-resolve-checker-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  // Custom checkers present on first import -> Config.cfg created with highest-priority custom checker
  fs.writeFileSync(path.join(directory, "checker.py"), "import sys\n");
  fs.writeFileSync(path.join(directory, "lcmp.cpp"), "int main(){}\n");
  ensureOrReconcileStoredProblemConfig("MEXARRAY", directory, "darwin");
  assert.equal(resolveProblemConfig("MEXARRAY", directory).checkerType, "lcmp.cpp");

  // Explicit built-in checker in Config.cfg -> uses selected checker instead of custom checker in folder
  writeStoredProblemConfig(directory, { checkerType: "C1" });
  assert.equal(resolveProblemConfig("MEXARRAY", directory, { checkerType: "lcmp.cpp" }).checkerType, "C1");

  writeStoredProblemConfig(directory, { checkerType: "polygon:lcmp" });
  assert.equal(resolveProblemConfig("MEXARRAY", directory).checkerType, "polygon:lcmp");

  writeStoredProblemConfig(directory, { checkerType: "checker.py" });
  assert.equal(resolveProblemConfig("MEXARRAY", directory).checkerType, "checker.py");
});

test("reconcileStoredProblemConfig resets legacy 1pt sum totalScore and redistributes fixed totalScore when tests change", () => {
  const legacyDefault = reconcileStoredProblemConfig(
    {
      defaultScore: 1,
      totalScore: "2",
      enableGroups: false,
      tests: { Test01: { points: 1 }, Test02: { points: 1 } },
      testScores: { Test01: 1, Test02: 1 },
    },
    ["Test01", "Test02", "Test03"],
  );
  assert.equal(legacyDefault.changed, true);
  assert.equal(legacyDefault.config.totalScore, null);
  assert.deepEqual(legacyDefault.config.tests, {
    Test01: { points: 1 },
    Test02: { points: 1 },
    Test03: { points: 1 },
  });

  const fixedTotal = reconcileStoredProblemConfig(
    {
      defaultScore: 1,
      totalScore: "10",
      enableGroups: false,
      tests: { Test01: { points: 5 }, Test02: { points: 5 }, Removed: { points: 5 } },
      testScores: { Test01: 5, Test02: 5, Removed: 5 },
    },
    ["Test01", "Test02", "Test03"],
  );
  assert.equal(fixedTotal.changed, true);
  assert.equal(fixedTotal.config.totalScore, "10");
  assert.deepEqual(fixedTotal.config.tests, {
    Test01: { points: "10/3" },
    Test02: { points: "10/3" },
    Test03: { points: "10/3" },
  });
});

test("readStoredProblemConfig and writeStoredProblemConfig handle lowercase config.cfg case-insensitively", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-case-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(path.join(directory, "config.cfg"), JSON.stringify({ totalScore: "2,5", memoryLimit: 512 }));
  const loaded = readStoredProblemConfig(directory);
  assert.ok(loaded);
  assert.equal(loaded.totalScore, "2,5");
  const resolved = resolveProblemConfig("CAU1", directory);
  assert.equal(resolved.totalScore, "2.5");
  assert.equal(resolved.memoryLimit, 512);
});
