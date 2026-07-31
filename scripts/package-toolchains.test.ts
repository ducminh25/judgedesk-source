import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
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

test("Full packaging selects every package for each release host", () => {
  const windows = selectHostToolchainReleases({
    platform: "win32",
    arch: "x64",
  });
  const macos = selectHostToolchainReleases({
    platform: "darwin",
    arch: "arm64",
  });

  assert.equal(windows.length, 8);
  assert.equal(macos.length, 7);
  assert.equal(macos.every((release) => release.arch === "arm64"), true);
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
  assert.doesNotMatch(
    workflow,
    /bundle-macos-x64|macos-15-intel|python-macos-x64|x86_64-apple-darwin/,
  );
});
