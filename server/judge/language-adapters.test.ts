import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildCompilerAdapterEnvironment,
  buildManagedPascalSupportArgs,
  buildNativeCompilationRecipe,
} from "./language-adapters.js";

test("native language recipes pin standards, offline behavior, and bounded outputs", () => {
  const pascal = buildNativeCompilationRecipe(
    "pascal",
    "win32",
    "source.pas",
    "program.exe",
  );
  assert.deepEqual(pascal.args, [
    "-O2",
    "-Xs",
    "-Sg",
    "-WR",
    "-Cs66060288",
    "-oprogram.exe",
    "source.pas",
  ]);

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
