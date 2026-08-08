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
import { createDefaultProblemConfig, normalizeProblemConfig } from "../../shared/problem-config.js";
import {
  readStoredProblemConfig,
  writeStoredProblemConfig,
} from "./problem-config-repository.js";

test("problem config defaults use the problem name and safe grading defaults", () => {
  assert.deepEqual(createDefaultProblemConfig("SUM"), {
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
    polygonConfig: { enableGroups: false, tests: {}, groups: {} }
  });
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
