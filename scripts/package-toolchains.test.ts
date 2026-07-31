import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildPackagingPascalSupportArgs,
  resolvePackagingHost,
  selectHostToolchainReleases,
} from "./package-toolchains.js";

test("release packaging supports Windows x64 and Apple Silicon only", () => {
  assert.deepEqual(resolvePackagingHost("win32", "x64"), {
    platform: "win32",
    arch: "x64",
  });
  assert.deepEqual(resolvePackagingHost("darwin", "arm64"), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.throws(
    () => resolvePackagingHost("darwin", "x64"),
    /Windows x64 and macOS Apple Silicon only/,
  );
});

test("Full packaging selects only the approved Themis-language package set", () => {
  const windows = selectHostToolchainReleases({
    platform: "win32",
    arch: "x64",
  });
  const macos = selectHostToolchainReleases({
    platform: "darwin",
    arch: "arm64",
  });

  assert.deepEqual(
    windows.map((release) => release.packageId),
    [
      "fpc-windows-x64",
      "gcc-windows-x64",
      "python-windows-x64",
      "temurin21-windows-x64",
    ],
  );
  assert.deepEqual(
    macos.map((release) => release.packageId),
    [
      "fpc-macos-arm64",
      "python-macos-arm64",
      "temurin21-macos-arm64",
    ],
  );
  assert.equal(macos.every((release) => release.arch === "arm64"), true);
});

test("deferred packages remain explicitly buildable without entering Full", () => {
  assert.deepEqual(
    selectHostToolchainReleases(
      { platform: "win32", arch: "x64" },
      ["go-windows-x64"],
    ).map((release) => release.packageId),
    ["go-windows-x64"],
  );
});

test("packaging rejects a requested package from another host", () => {
  assert.throws(
    () => selectHostToolchainReleases(
      { platform: "darwin", arch: "arm64" },
      ["gcc-windows-x64"],
    ),
    /not built on darwin\/arm64/,
  );
});

test("macOS FPC packaging pins the selected SDK before managed unit roots", (t) => {
  const sdk = path.resolve("build", "packager-test-sdk");
  fs.mkdirSync(sdk, { recursive: true });
  t.after(() => fs.rmSync(sdk, { recursive: true, force: true }));

  const args = buildPackagingPascalSupportArgs(
    "darwin",
    path.resolve("managed-fpc"),
    sdk,
  );
  assert.equal(args[0], `-XR${fs.realpathSync(sdk)}`);
  assert.ok(args.some((argument) => argument.startsWith("-Fu")));
  assert.throws(
    () => buildPackagingPascalSupportArgs(
      "darwin",
      path.resolve("managed-fpc"),
    ),
    /macOS SDK is required/,
  );
});

test("toolchain publishing workflow has no Intel macOS release path", () => {
  const workflow = fs.readFileSync(
    path.resolve(".github", "workflows", "toolchains.yml"),
    "utf8",
  );

  assert.match(workflow, /bundle-windows:/);
  assert.match(workflow, /bundle-macos-arm64:/);
  assert.match(
    workflow,
    /needs: \[bundle-windows, bundle-macos-arm64\]/,
  );
  assert.match(
    workflow,
    /npm run toolchains:package:host -- dist-toolchains/g,
  );
  assert.equal(
    workflow.match(
      /npm run toolchains:prepare:gate -- dist-toolchains build\/toolchain-gate-root/g,
    )?.length,
    2,
  );
  assert.match(
    workflow,
    /\.\/scripts\/prepare-windows-toolchain-gate-acl\.ps1 build\/toolchain-gate-root/,
  );
  assert.equal(
    workflow.match(/server\/judge\/c-submission\.gate\.test\.ts/g)?.length,
    2,
  );
  assert.equal(
    workflow.match(/server\/judge\/multi-language\.gate\.test\.ts/g)?.length,
    2,
  );
  assert.equal(
    workflow.match(/server\/judge\/custom-checker\.gate\.test\.ts/g)?.length,
    2,
  );
  assert.equal(
    workflow.match(/JUDGEDESK_REAL_LANGUAGE_GATES: pascal,java,python/g)?.length,
    2,
  );
  assert.doesNotMatch(
    workflow,
    /package all (?:Windows|Apple Silicon) toolchains/i,
  );
  assert.doesNotMatch(
    workflow,
    /bundle-macos-x64|macos-15-intel|python-macos-x64|x86_64-apple-darwin/,
  );
});
