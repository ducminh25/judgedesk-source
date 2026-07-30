import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import type { NormalizedProblemConfig } from "../types.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { getToolchainsDir } from "../toolchains/storage.js";

const enabled =
  (process.platform === "win32" || process.platform === "darwin")
  && process.env.JUDGEDESK_REAL_TOOLCHAIN_GATES === "1";

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
  "the selected C compiler builds and executes C11 inside the secure runner",
  {
    skip: enabled
      ? false
      : "set JUDGEDESK_REAL_TOOLCHAIN_GATES=1 on Windows or macOS",
  },
  async (t) => {
    const [{ executorClient }, { compileSubmission }, { runTestCase }] =
      await Promise.all([
        import("../executor/client.js"),
        import("./compiler.js"),
        import("./testcase-runner.js"),
      ]);
    const compiler = process.platform === "win32"
      ? path.join(
          getToolchainsDir(),
          "gcc-windows-x64",
          "bin",
          "gcc.exe",
        )
      : execFileSync("/usr/bin/xcrun", ["--find", "clang"], {
          encoding: "utf8",
        }).trim();
    assert.ok(fs.existsSync(compiler), `C compiler is missing at ${compiler}`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-c-gate-"));
    t.after(async () => {
      await executorClient.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      if (macosTreeGuard) {
        fs.rmSync(macosTreeGuard, { recursive: true, force: true });
      }
    });
    const source = path.join(root, "SUM.c");
    const input = path.join(root, "input.txt");
    const expected = path.join(root, "expected.txt");
    fs.writeFileSync(
      source,
      [
        "#include <stdio.h>",
        "int main(void) {",
        "  long long a, b;",
        "  if (scanf(\"%lld%lld\", &a, &b) != 2) return 1;",
        "  printf(\"%lld\\n\", a + b);",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(input, "19 23\n", "utf8");
    fs.writeFileSync(expected, "42\n", "utf8");
    const cToolchain: ResolvedToolchain = {
      kind: "c",
      source: process.platform === "win32" ? "managed" : "system",
      executablePath: compiler,
      version: process.platform === "win32" ? "14.2.0" : "17.0.0",
      ready: true,
      provenance:
        process.platform === "win32"
          ? "managed-package"
          : "platform-certified",
    };
    const compiled = await compileSubmission({
      language: "c",
      contestantName: "student",
      problemName: "SUM",
      submissionPath: source,
      tempDirectory: root,
      cToolchain,
    });
    assert.equal(compiled.compileStatus, "OK", compiled.compileError);
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
    const result = await runTestCase({
      contestant: "student",
      problemName: "SUM",
      testName: "1",
      language: "c",
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
    });
    assert.equal(result.status, "AC", result.errorDetail);
    assert.equal(result.score, 1);
  },
);
