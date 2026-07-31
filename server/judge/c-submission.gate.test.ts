import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import type { NormalizedProblemConfig } from "../types.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

const builtInRoot = process.env.JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT;
const enabled =
  (process.platform === "win32" || process.platform === "darwin")
  && process.env.JUDGEDESK_REAL_TOOLCHAIN_GATES === "1"
  && !!builtInRoot;
if (enabled) {
  process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = path.resolve(builtInRoot!);
}

function provisionMacosTreeGuard(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.JUDGEDESK_TREE_GUARD_REQUIRED === "1") return null;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-c-gate-tree-guard-"),
  );
  const generation = crypto.randomBytes(32).toString("hex");
  const guardPath = path.join(directory, "process-tree.generation");
  fs.writeFileSync(
    guardPath,
    `JUDGEDESK_PROCESS_TREE/1\ngeneration=${generation}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.env.JUDGEDESK_TREE_GUARD_REQUIRED = "1";
  process.env.JUDGEDESK_TREE_GUARD_PATH = guardPath;
  process.env.JUDGEDESK_TREE_GUARD_GENERATION = generation;
  return directory;
}

const macosTreeGuard = enabled ? provisionMacosTreeGuard() : null;

test(
  "the selected C++14 and C11 compilers build and execute inside the secure runner",
  {
    skip: enabled
      ? false
      : "set JUDGEDESK_REAL_TOOLCHAIN_GATES=1 and JUDGEDESK_REAL_TOOLCHAIN_GATE_ROOT",
  },
  async (t) => {
    const [
      { executorClient },
      { compileSubmission },
      { runTestCase },
      { resolveManagedToolchain },
    ] =
      await Promise.all([
        import("../executor/client.js"),
        import("./compiler.js"),
        import("./testcase-runner.js"),
        import("../toolchains/resolver.js"),
      ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-c-gate-"));
    t.after(async () => {
      await executorClient.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      if (macosTreeGuard) {
        fs.rmSync(macosTreeGuard, { recursive: true, force: true });
      }
    });
    const input = path.join(root, "input.txt");
    const expected = path.join(root, "expected.txt");
    fs.writeFileSync(input, "19 23\n", "utf8");
    fs.writeFileSync(expected, "42\n", "utf8");
    const config: NormalizedProblemConfig = {
      useStdIO: true,
      useStdIn: true,
      useStdOut: true,
      inputFile: "SUM.inp",
      outputFile: "SUM.out",
      totalScore: 1,
      defaultScore: 1,
      testScores: {},
      memoryLimit: 256,
      checkerType: "C1",
      polygonConfig: {
        enableGroups: false,
        tests: {},
        groups: {},
      },
    };
    const cases = [
      {
        language: "cpp",
        extension: ".cpp",
        compilerName: "clang++",
        source: [
          "#include <iostream>",
          "int main() {",
          "  long long a, b;",
          "  if (!(std::cin >> a >> b)) return 1;",
          "  std::cout << a + b << '\\n';",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
      {
        language: "c",
        extension: ".c",
        compilerName: "clang",
        source: [
          "#include <stdio.h>",
          "int main(void) {",
          "  long long a, b;",
          "  if (scanf(\"%lld%lld\", &a, &b) != 2) return 1;",
          "  printf(\"%lld\\n\", a + b);",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
    ] as const;
    for (const gate of cases) {
      await t.test(gate.language, async () => {
        const compiler = process.platform === "win32"
          ? path.join(
              path.resolve(builtInRoot!),
              "gcc-windows-x64",
              "bin",
              gate.language === "cpp" ? "g++.exe" : "gcc.exe",
            )
          : execFileSync(
              "/usr/bin/xcrun",
              ["--find", gate.compilerName],
              { encoding: "utf8" },
            ).trim();
        assert.ok(
          fs.existsSync(compiler),
          `${gate.language} compiler is missing at ${compiler}`,
        );
        const source = path.join(root, `SUM${gate.extension}`);
        fs.writeFileSync(source, gate.source, "utf8");
        const toolchain: ResolvedToolchain = process.platform === "win32"
          ? resolveManagedToolchain(gate.language)
          : {
              kind: gate.language,
              source: "system",
              executablePath: compiler,
              version: "17.0.0",
              ready: true,
              provenance: "platform-certified",
            };
        assert.equal(
          toolchain.ready,
          true,
          toolchain.diagnostic
            || `managed ${gate.language} compiler is not ready`,
        );
        const compiled = await compileSubmission({
          language: gate.language,
          contestantName: "student",
          problemName: "SUM",
          submissionPath: source,
          tempDirectory: root,
          toolchains: { [gate.language]: toolchain },
        });
        assert.equal(compiled.compileStatus, "OK", compiled.compileError);
        const result = await runTestCase({
          contestant: "student",
          problemName: "SUM",
          testName: "1",
          language: gate.language,
          submissionPath: source,
          executablePath: compiled.executablePath,
          inputPath: input,
          expectedOutputPath: expected,
          expectedOutput: "42\n",
          testRoot: root,
          contestantsRoot: root,
          tempDirectory: root,
          pythonCommand: "",
          timeLimitMs: 1_000,
          score: 1,
          config,
          checker: undefined,
          program: compiled.program,
        });
        assert.equal(result.status, "AC", result.errorDetail);
        assert.equal(result.score, 1);
      });
    }
  },
);
