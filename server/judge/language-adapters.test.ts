import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createCompileConfig,
  createCustomCompileConfig,
} from "../../shared/compile-config.js";
import {
  buildCompilerAdapterEnvironment,
  buildJavaCompilationArgs,
  buildManagedPascalSupportArgs,
  buildNativeCompilationRecipe,
} from "./language-adapters.js";

test("C and C++ split compilation share an explicit two-phase budget", () => {
  for (const language of ["c", "cpp"] as const) {
    const recipe = buildNativeCompilationRecipe(
      language,
      "win32",
      `submission.${language === "c" ? "c" : "cpp"}`,
      "submission.exe",
    );
    assert.equal(recipe.splitCompilerPhases, true);
    assert.equal(recipe.timeoutMs, 60_000);
  }
});

test("Windows compiler recipes merge protected static, stack, and C-only math flags", () => {
  const cpp = buildNativeCompilationRecipe(
    "cpp",
    "win32",
    "source.cpp",
    "program.exe",
    createCompileConfig("modern_ioi_icpc_2025"),
  );
  assert.deepEqual(cpp.args, [
    "-std=gnu++20",
    "-O2",
    "-pipe",
    "-static",
    "-x",
    "c++",
    "-Wl,--stack,66060288",
    "source.cpp",
    "-o",
    "program.exe",
  ]);
  assert.ok(!cpp.args.includes("-s"));
  assert.ok(!cpp.args.includes("-lm"));

  const c = buildNativeCompilationRecipe(
    "c",
    "win32",
    "source.c",
    "program.exe",
    createCompileConfig("modern_ioi_icpc_2025"),
  );
  assert.deepEqual(c.args, [
    "-std=gnu17",
    "-O2",
    "-pipe",
    "-static",
    "-x",
    "c",
    "-Wl,--stack,66060288",
    "source.c",
    "-o",
    "program.exe",
    "-lm",
  ]);
});

test("macOS compiler recipes keep platform-independent flags and omit GNU link flags", () => {
  const cpp = buildNativeCompilationRecipe(
    "cpp",
    "darwin",
    "/workspace/source.cpp",
    "/workspace/program",
    createCompileConfig("icpc_world_finals"),
  );
  assert.deepEqual(cpp.args, [
    "-std=gnu++20",
    "-O2",
    "-g",
    "-x",
    "c++",
    "/workspace/source.cpp",
    "-o",
    "/workspace/program",
  ]);
  for (const forbidden of ["-static", "-s", "-lm", "-Wl,--stack,66060288"]) {
    assert.ok(!cpp.args.includes(forbidden));
  }
});

test("custom compile snapshots are applied per language before protected arguments", () => {
  const custom = createCustomCompileConfig({
    cpp: ["-std=gnu++20", "-O1", "-DCPP_ONLY=1"],
    c: ["-std=gnu17", "-O3", "-DC_ONLY=1"],
  });
  const cpp = buildNativeCompilationRecipe(
    "cpp",
    "darwin",
    "source.cpp",
    "program",
    custom,
  );
  const c = buildNativeCompilationRecipe(
    "c",
    "win32",
    "source.c",
    "program.exe",
    custom,
  );
  assert.deepEqual(cpp.args.slice(0, 3), ["-std=gnu++20", "-O1", "-DCPP_ONLY=1"]);
  assert.deepEqual(c.args.slice(0, 3), ["-std=gnu17", "-O3", "-DC_ONLY=1"]);
});

test("native language recipes pin standards, offline behavior, and bounded outputs", () => {
  const pascal = buildNativeCompilationRecipe(
    "pascal",
    "win32",
    "source.pas",
    "program.exe",
  );
  assert.deepEqual(pascal.args, [
    "-O2",
    "-XS",
    "-Sg",
    "-WR",
    "-Xs",
    "-Cs66060288",
    "-oprogram.exe",
    "source.pas",
  ]);
  assert.equal(pascal.timeoutMs, 45_000);

  const go = buildNativeCompilationRecipe(
    "go",
    "darwin",
    "source.go",
    "program",
  );
  assert.deepEqual(go.environment, {
    CGO_ENABLED: "0",
    GO111MODULE: "off",
    GOTOOLCHAIN: "local",
  });
  assert.ok(go.args.includes("-trimpath"));
  assert.ok(go.args.includes("-buildvcs=false"));
  assert.ok(go.args.includes("-p=4"));
  assert.equal(go.timeoutMs, 60_000);
  assert.equal(go.maxGeneratedFileBytes, 64 * 1024 * 1024);
  assert.equal(go.maxWorkspaceWriteBytes, 256 * 1024 * 1024);
  assert.equal(go.maxCreatedFiles, 4_096);

  const rust = buildNativeCompilationRecipe(
    "rust",
    "darwin",
    "source.rs",
    "program",
  );
  assert.deepEqual(rust.args.slice(0, 2), ["--edition=2021", "-C"]);
  assert.equal(rust.environment.RUST_BACKTRACE, "0");
});

test("managed Pascal ignores host config and pins its packaged target roots", () => {
  const root = path.resolve("managed-fpc");
  const args = buildManagedPascalSupportArgs("win32", root);
  assert.deepEqual(args.slice(0, 3), ["-n", "-Px86_64", "-Twin64"]);
  assert.ok(args.includes(`-Fu${path.join(root, "units", "x86_64-win64", "*")}`));
  assert.ok(args.includes(`-FD${path.join(root, "bin")}`));
  assert.ok(args.includes("-XPx86_64-win64-"));
});

test("Java keeps the Themis javac default while isolating class artifacts", () => {
  assert.deepEqual(
    buildJavaCompilationArgs("Main.java", "classes"),
    ["-d", "classes", "Main.java"],
  );
});

test("compiler adapters keep caches and package roots inside the executor contract", () => {
  const workspace = path.resolve("executor-workspace");
  const root = path.resolve("managed-toolchain");
  const go = buildCompilerAdapterEnvironment(
    "go",
    workspace,
    root,
    path.join(root, "bin", "go"),
  );
  assert.equal(go.GOCACHE, path.join(workspace, "go-cache"));
  assert.equal(go.GOMODCACHE, path.join(workspace, "go-mod-cache"));
  assert.equal(go.GOTMPDIR, path.join(workspace, "go-tmp"));
  assert.equal(go.GOMAXPROCS, "4");

  const executable = path.join(root, "bin", "dotnet");
  const dotnet = buildCompilerAdapterEnvironment(
    "csharp",
    workspace,
    root,
    executable,
  );
  assert.equal(dotnet.DOTNET_ROOT, root);
  assert.equal(dotnet.DOTNET_CLI_HOME, path.join(workspace, "dotnet-home"));
  assert.equal(dotnet.NUGET_PACKAGES, path.join(workspace, "nuget-packages"));
  assert.equal(dotnet.DOTNET_MULTILEVEL_LOOKUP, "0");
  assert.equal(dotnet.PATH, path.dirname(executable));
});
