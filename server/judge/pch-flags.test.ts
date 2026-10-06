import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeCompilationRecipe } from "./language-adapters.js";
import { buildCompilerPhases } from "./compiler.js";
import { getPchCompilerFlags } from "./universal-pch.js";
import { createCustomCompileConfig } from "../../shared/compile-config.js";

test("PCH compatibility follows the configured flags, excluding source/link paths", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const recipe = buildNativeCompilationRecipe("cpp", platform, "source file.cpp", "program.out");
    assert.deepEqual(getPchCompilerFlags(recipe.args, platform), ["-std=c++14", "-O2", "-pipe"]);
    const phases = buildCompilerPhases(recipe.args, "program.out", "program.o");
    assert.deepEqual(getPchCompilerFlags(phases.compile, platform), ["-std=c++14", "-O2", "-pipe"]);
    assert.equal(getPchCompilerFlags(phases.link), null, "linker does not need an 80MB PCH copy");
  }
  const custom = createCustomCompileConfig({ cpp: ["-std=c++20", "-O0", "-DTEST=1", "-fno-exceptions"], c: ["-O2"] });
  const recipe = buildNativeCompilationRecipe("cpp", "win32", "source.cpp", "program.out", custom);
  assert.deepEqual(getPchCompilerFlags(recipe.args), custom.flags.cpp);
  assert.equal(getPchCompilerFlags(["--test-sleep"]), null);
  assert.equal(getPchCompilerFlags(buildNativeCompilationRecipe("c", "win32", "source.c", "program.out").args), null);
});

test("Windows sanitizer flags retain a separate PCH identity", () => {
  const flags = ["-std=c++14", "-O2", "-pipe", "-fsanitize=integer-divide-by-zero", "-fsanitize-trap=integer-divide-by-zero"];
  assert.deepEqual(getPchCompilerFlags([...flags, "-x", "c++", "owned.cpp", "-o", "owned.out"], "win32"), flags);
});

test("checker and interactor include-root requests keep their own headers without a universal PCH", () => {
  assert.equal(getPchCompilerFlags(["-std=c++14", "-O2", "-pipe", "-I", "/owned/testlib", "-x", "c++", "checker.cpp"]), null);
  assert.equal(getPchCompilerFlags(["-std=c++14", "-O2", "-I/owned/testlib", "-x", "c++", "interactor.cpp"]), null);
});
