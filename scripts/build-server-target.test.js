import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { targetTripleForHost } from "./build-server-target.js";
import {
  bundleServer,
  replaceFileAtomically,
  resolveTarget,
} from "./build-server-lib.js";
import { smokeTestSidecar } from "./smoke-test-sidecar.js";

test("sidecar target names match Tauri target triples", () => {
  assert.equal(targetTripleForHost("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(targetTripleForHost("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(targetTripleForHost("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetTripleForHost("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(
    targetTripleForHost("linux", "arm64"),
    "aarch64-unknown-linux-gnu",
  );
  assert.throws(() => targetTripleForHost("win32", "arm64"), /Unsupported/);
});

test("resolveTarget matches host targets and handles errors", () => {
  // Matching host architecture should succeed
  assert.equal(
    resolveTarget("win32", "x64", "x86_64-pc-windows-msvc"),
    "x86_64-pc-windows-msvc",
  );
  assert.equal(
    resolveTarget("darwin", "arm64", "aarch64-apple-darwin"),
    "aarch64-apple-darwin",
  );

  // No environment target specified should default to host target
  assert.equal(
    resolveTarget("win32", "x64", undefined),
    "x86_64-pc-windows-msvc",
  );

  // Mismatch target should throw a helpful error
  assert.throws(
    () => resolveTarget("win32", "x64", "aarch64-apple-darwin"),
    /Cannot build aarch64-apple-darwin sidecar/,
  );
  assert.throws(
    () => resolveTarget("darwin", "x64", "universal-apple-darwin"),
    /Cannot build universal-apple-darwin sidecar/,
  );
});

test("replaceFileAtomically replaces an existing sidecar without leaving staging files", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-sidecar-atomic-"),
  );
  const sourcePath = path.join(directory, "new.exe");
  const finalPath = path.join(directory, "server.exe");
  try {
    fs.writeFileSync(sourcePath, "new-sidecar");
    fs.writeFileSync(finalPath, "old-sidecar");

    replaceFileAtomically(sourcePath, finalPath);

    assert.equal(fs.readFileSync(finalPath, "utf8"), "new-sidecar");
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      "new.exe",
      "server.exe",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bundleServer uses esbuild's cross-platform JavaScript API", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "themis-esbuild-"));
  try {
    fs.writeFileSync(
      path.join(directory, "server.ts"),
      "const answer: number = 42; console.log(answer);",
    );

    bundleServer(directory, "server.ts", "dist/server.cjs");

    const output = fs.readFileSync(
      path.join(directory, "dist", "server.cjs"),
      "utf8",
    );
    assert.match(output, /42/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bundleServer embeds canonical testlib without shipping the header as a resource", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-testlib-"));
  try {
    fs.mkdirSync(path.join(directory, "judgers"), { recursive: true });
    fs.writeFileSync(path.join(directory, "judgers", "testlib.h"), "JUDGEDESK_TESTLIB_SENTINEL");
    fs.writeFileSync(
      path.join(directory, "server.ts"),
      "declare const __JUDGEDESK_TESTLIB__: string; console.log(__JUDGEDESK_TESTLIB__);",
    );
    bundleServer(directory, "server.ts", "dist/server.cjs");
    const output = fs.readFileSync(path.join(directory, "dist", "server.cjs"), "utf8");
    assert.match(output, /JUDGEDESK_TESTLIB_SENTINEL/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Tauri embeds checker previews and does not install editable checker resources", () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const resources = JSON.stringify(tauriConfig.bundle.resources);
  assert.doesNotMatch(resources, /judgers|testlib|\.cpp/);
  assert.equal(
    tauriConfig.bundle.resources["../compiler-compat/include/bits/stdc++.h"],
    "compiler-compat/include/bits/stdc++.h",
  );
  const compatibilityHeader = fs.readFileSync(
    new URL("../compiler-compat/include/bits/stdc++.h", import.meta.url),
    "utf8",
  );
  assert.match(compatibilityHeader, /#include <algorithm>/);
  assert.match(compatibilityHeader, /#include <vector>/);

  const viewerSource = fs.readFileSync(
    new URL("../src-tauri/src/checker_sources.rs", import.meta.url),
    "utf8",
  );
  assert.match(viewerSource, /include_str!\("\.\.\/\.\.\/judgers\/testlib\.h"\)/);
  assert.match(viewerSource, /unique_preview_directory/);
  assert.match(viewerSource, /fs::write\(preview_directory\.join\("testlib\.h"\)/);
  assert.doesNotMatch(viewerSource, /copy_once/);
});

test("macOS SEA build removes the inherited signature before injection and signs afterward", () => {
  const buildSource = fs.readFileSync(
    new URL("./build-server-lib.js", import.meta.url),
    "utf8",
  );
  const workflowBody = buildSource.slice(
    buildSource.indexOf("export function runBuildWorkflow"),
  );
  const removeSignatureAt = workflowBody.indexOf(
    "prepareExecutableForInjection(tempTargetPath, platform)",
  );
  const injectAt = workflowBody.indexOf("injectSeaBlob(");
  const signAt = workflowBody.indexOf(
    "signExecutable(tempTargetPath, platform)",
  );

  assert.match(buildSource, /codesign[^\n]+--remove-signature/);
  assert.ok(removeSignatureAt >= 0);
  assert.ok(injectAt > removeSignatureAt);
  assert.ok(signAt > injectAt);
});

test("sidecar smoke test verifies a real child process over HTTP", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "themis-smoke-test-"));
  const serverScript = path.join(directory, "server.cjs");
  try {
    fs.writeFileSync(
      serverScript,
      [
        'const http = require("node:http");',
        "const port = Number(process.env.PORT);",
        "http.createServer((request, response) => {",
        '  response.writeHead(200, { "content-type": "application/json" });',
        '  if (request.url === "/api/status") { response.end(JSON.stringify({ healthy: true })); return; }',
        '  if (request.url.startsWith("/api/fetch-contestants")) { response.end(JSON.stringify({ success: true, data: ["Contestant 2", "Contestant 10"] })); return; }',
        '  if (request.url.startsWith("/api/fetch-problems")) { response.end(JSON.stringify({ success: true, data: ["Problem A", "Problem B"] })); return; }',
        "  response.writeHead(404).end();",
        '}).listen(port, "127.0.0.1");',
      ].join("\n"),
    );

    const status = await smokeTestSidecar(process.execPath, {
      args: [serverScript],
      timeoutMs: 5_000,
    });
    assert.deepEqual(status, { healthy: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub release workflow builds Apple Silicon only", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const macJob = workflow.slice(
    workflow.indexOf("  build-macos-arm64-dmg:"),
    workflow.indexOf("  build-windows-msi:"),
  );

  assert.match(macJob, /--target aarch64-apple-darwin/);
  assert.match(macJob, /build-macos-arm64-sidecar\.sh/);
  assert.match(macJob, /verify-macos-arm64-bundle\.sh/);
  assert.doesNotMatch(workflow, /build-macos-universal-dmg/);
  assert.doesNotMatch(workflow, /x86_64-apple-darwin/);
  assert.match(
    workflow,
    /needs: \[build-windows-msi, build-macos-arm64-dmg\]/,
  );

  const macConfig = JSON.parse(
    fs.readFileSync(
      new URL("../src-tauri/tauri.macos.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(macConfig.bundle.targets, ["app", "dmg"]);
  assert.equal(macConfig.bundle.macOS.entitlements, "./Entitlements.plist");
  const rootConfig = JSON.parse(
    fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.equal(rootConfig.productName, "JudgeDesk");
  assert.equal(rootConfig.app.windows[0].title, "JudgeDesk");

  const entitlements = fs.readFileSync(
    new URL("../src-tauri/Entitlements.plist", import.meta.url),
    "utf8",
  );
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
});

test("Apple Silicon release scripts verify architecture, DMG, and sidecar", () => {
  const sidecarScript = fs.readFileSync(
    new URL("./build-macos-arm64-sidecar.sh", import.meta.url),
    "utf8",
  );
  const bundleScript = fs.readFileSync(
    new URL("./verify-macos-arm64-bundle.sh", import.meta.url),
    "utf8",
  );
  const macExecutor = fs.readFileSync(
    new URL("../native-executor/src/platform/macos.rs", import.meta.url),
    "utf8",
  );
  const executorMain = fs.readFileSync(
    new URL("../native-executor/src/main.rs", import.meta.url),
    "utf8",
  );
  const securityHarness = fs.readFileSync(
    new URL("../server/executor-tests/security.integration.test.ts", import.meta.url),
    "utf8",
  );

  assert.match(sidecarScript, /lipo "\$sidecar" -verify_arch arm64/);
  assert.match(sidecarScript, /smoke-test-sidecar\.js "\$sidecar"/);
  assert.match(sidecarScript, /test:executor/);
  assert.match(sidecarScript, /security\.integration\.test\.ts/);
  assert.match(sidecarScript, /smoke-test-macos-compiler\.ts/);
  assert.match(sidecarScript, /set_limit\(libc::RLIMIT_NPROC/);
  assert.match(sidecarScript, /--test-process-bomb/);
  assert.match(sidecarScript, /kernel process ceiling contains a real process bomb/);
  assert.doesNotMatch(sidecarScript, /macOS diagnostics/);
  assert.match(macExecutor, /libc::wait4/);
  assert.match(macExecutor, /ru_maxrss/);
  assert.match(macExecutor, /set_limit\(libc::RLIMIT_NPROC, nproc_ceiling\)/);
  assert.match(macExecutor, /startup_process_limit_probe/);
  assert.match(macExecutor, /wait_for_process_group_empty/);
  assert.match(executorMain, /Some\("--test-process-bomb"\)/);
  assert.match(securityHarness, /kernel process ceiling contains a real process bomb/);
  assert.match(securityHarness, /processCount:\s*1/);
  assert.match(securityHarness, /"process_limit"/);
  assert.match(bundleScript, /hdiutil attach "\$dmg_file" -readonly -nobrowse/);
  assert.match(bundleScript, /trap cleanup_dmg_mount EXIT/);
  assert.match(bundleScript, /Contents\/MacOS\/themis-v2" -verify_arch arm64/);
  assert.match(bundleScript, /lipo "\$server_binary" -verify_arch arm64/);
  assert.match(bundleScript, /codesign -d --entitlements :- "\$server_binary"/);
  assert.match(bundleScript, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(bundleScript, /smoke-test-sidecar\.js/);
  assert.match(bundleScript, /--require-cpp/);
});

test("release publishing targets the public distribution repository", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const releaseJob = workflow.slice(workflow.indexOf("  release:"));

  assert.match(
    releaseJob,
    /PUBLIC_RELEASE_REPOSITORY: ducminh25\/themis-v2/,
  );
  assert.match(releaseJob, /GH_TOKEN: \$\{\{ secrets\.PUBLIC_RELEASE_TOKEN \}\}/);
  assert.match(
    releaseJob,
    /gh release view[^\n]+--repo "\$PUBLIC_RELEASE_REPOSITORY"/,
  );
  assert.match(
    releaseJob,
    /gh release upload[^\n]+--repo "\$PUBLIC_RELEASE_REPOSITORY"/,
  );
  assert.match(
    releaseJob,
    /gh release create[^\n]+--repo "\$PUBLIC_RELEASE_REPOSITORY"/,
  );
});

test("release workflow signs, flattens, and publishes updater artifacts", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const macBundleScript = fs.readFileSync(
    new URL("./verify-macos-arm64-bundle.sh", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(workflow, /release-assets-windows\/\*/);
  assert.match(workflow, /release-assets-mac\/\*/);
  assert.match(macBundleScript, /\.app\.tar\.gz\.sig/);
  assert.match(workflow, /generate-updater-manifest\.js release-assets/);
  assert.match(workflow, /gh release upload[^\n]+release-assets\/\*/);
});

test("Codemagic builds verified Apple Silicon release artifacts on M2", () => {
  const codemagic = fs.readFileSync(
    new URL("../codemagic.yaml", import.meta.url),
    "utf8",
  );
  const sidecarScript = fs.readFileSync(
    new URL("./build-macos-arm64-sidecar.sh", import.meta.url),
    "utf8",
  );
  const bundleScript = fs.readFileSync(
    new URL("./verify-macos-arm64-bundle.sh", import.meta.url),
    "utf8",
  );

  assert.match(codemagic, /instance_type: mac_mini_m2/);
  assert.match(codemagic, /node: 22\.23\.1/);
  assert.match(codemagic, /groups:\s+\- themis_signing/);
  assert.match(codemagic, /https:\/\/sh\.rustup\.rs/);
  assert.match(codemagic, /PATH=\$HOME\/\.cargo\/bin:\$PATH/);
  assert.match(codemagic, />> "\$CM_ENV"/);
  assert.match(codemagic, /--target aarch64-apple-darwin/);
  assert.match(codemagic, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.match(codemagic, /JudgeDesk\.app\.tar\.gz\.sig/);
  assert.match(sidecarScript, /TAURI_TARGET=aarch64-apple-darwin/);
  assert.doesNotMatch(sidecarScript, /x86_64/);
  assert.match(sidecarScript, /smoke-test-macos-compiler\.ts/);
  assert.match(bundleScript, /Contents\/MacOS\/themis-v2" -verify_arch arm64/);
  assert.match(bundleScript, /lipo "\$server_binary" -verify_arch arm64/);
  assert.match(bundleScript, /smoke-test-sidecar\.js/);
});

test("Codemagic builds signed Windows updater artifacts on a Windows VM", () => {
  const codemagic = fs.readFileSync(
    new URL("../codemagic.yaml", import.meta.url),
    "utf8",
  );
  const windowsWorkflow = codemagic.slice(
    codemagic.indexOf("  windows-x64-release:"),
  );

  assert.match(windowsWorkflow, /instance_type: windows_x2/);
  assert.match(windowsWorkflow, /node: 22\.23\.1/);
  assert.match(windowsWorkflow, /groups:\s+\- themis_signing/);
  assert.match(windowsWorkflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(windowsWorkflow, /TAURI_TARGET = 'x86_64-pc-windows-msvc'/);
  assert.match(windowsWorkflow, /tauri\.windows\.conf\.json/);
  assert.match(windowsWorkflow, /JudgeDesk_\*\.msi\.sig/);
  assert.match(windowsWorkflow, /SHA256SUMS-windows/);
});

test("Codemagic can sign a locally built Windows MSI with the existing updater key", () => {
  const codemagic = fs.readFileSync(
    new URL("../codemagic.yaml", import.meta.url),
    "utf8",
  );
  const signingWorkflow = codemagic.slice(
    codemagic.indexOf("  windows-updater-signing:"),
  );

  assert.match(signingWorkflow, /instance_type: mac_mini_m2/);
  assert.match(signingWorkflow, /groups:\s+\- themis_signing/);
  assert.match(signingWorkflow, /v\$\{version\}-staging/);
  assert.match(signingWorkflow, /tauri signer sign/);
  assert.match(signingWorkflow, /JudgeDesk_\*\.msi\.sig/);
});
