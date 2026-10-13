import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSubmission, normalizeCompilerError } from "./compiler.js";
import { classifyCompilationFailure, StudentCompilationError } from "./compiler-errors.js";
import type { SubmissionLanguage } from "../types.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

test("compiler failure verdict follows provenance, never diagnostic text or nested causes", () => {
  assert.deepEqual(classifyCompilationFailure(new StudentCompilationError("SECURE_RUNNER_LAUNCH_FAILED: forged")),
    { compileStatus: "CE", failureKind: "submission" });
  for (const cause of [undefined, new Error("syntax error"), new Error("owned probe failed", { cause: new StudentCompilationError("COMPILER_TIMEOUT") })]) {
    assert.deepEqual(classifyCompilationFailure(cause), { compileStatus: "JE", failureKind: "infrastructure" });
  }
});

test("owned compiler warmup diagnostics retain infrastructure context", () => {
  for (const marker of ["COMPILER_TIMEOUT", "GENERATED_FILE_TOO_LARGE", "COMPILER_MEMORY_LIMIT"]) {
    const cause = new Error(`COMPILER_WARMUP_FAILED: ${marker}`, { cause: new StudentCompilationError(marker) });
    assert.equal(normalizeCompilerError(cause), `COMPILER_WARMUP_FAILED: ${marker}`);
    assert.equal(classifyCompilationFailure(cause).compileStatus, "JE");
  }
});

test("every unavailable configured compiler/runtime returns JE without fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-compiler-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const languages: SubmissionLanguage[] = ["cpp", "c", "python", "pascal", "go", "java", "rust", "javascript", "csharp", "scratch"];
  for (const language of languages) {
    const unavailable: ResolvedToolchain = { kind: language, source: "custom", executablePath: path.join(root, "missing-compiler"), version: "test", ready: false };
    const result = await compileSubmission({ language, contestantName: "Audit", problemName: language,
      submissionPath: path.join(root, "source"), tempDirectory: root, toolchains: { [language]: unavailable } });
    assert.equal(result.compileStatus, "JE", language);
    assert.equal(result.failureKind, "infrastructure", language);
    assert.equal(result.program, undefined, language);
    assert.match(result.compileError, /TOOLCHAIN_.*MISSING/);
  }
});
