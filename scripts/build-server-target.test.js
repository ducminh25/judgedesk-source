import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { targetTripleForHost } from "./build-server-target.js";
import {
  bundleServer,
  replaceFileAtomically,
  resolveBuildMetadata,
  resolveTarget,
} from "./build-server-lib.js";
import {
  smokeTestSidecar,
  toTauriResourceDirectory,
} from "./smoke-test-sidecar.js";

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

test("build metadata is deterministic when release environment values are provided", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-build-metadata-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ version: "9.8.7" }),
  );
  assert.deepEqual(
    resolveBuildMetadata(directory, {
      JUDGEDESK_GIT_COMMIT: "abc123",
      JUDGEDESK_BUILD_NUMBER: "42",
      SOURCE_DATE_EPOCH: "1700000000",
    }),
    {
      appVersion: "9.8.7",
      gitCommit: "abc123",
      buildNumber: "42",
      builtAt: "2023-11-14T22:13:20.000Z",
    },
  );
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
  assert.match(buildSource, /chmodSync\(targetPath,[^\n]+\| 0o200\)/);
  assert.ok(removeSignatureAt >= 0);
  assert.ok(injectAt > removeSignatureAt);
  assert.ok(signAt > injectAt);
});

test("sidecar smoke test verifies a real child process over HTTP", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "themis-smoke-test-"));
  const serverScript = path.join(directory, "server.cjs");
  try {
    const compatibilityHeader = path.join(
      directory,
      "compiler-compat",
      "include",
      "bits",
      "stdc++.h",
    );
    fs.mkdirSync(path.dirname(compatibilityHeader), { recursive: true });
    fs.writeFileSync(compatibilityHeader, "// packaged compatibility header\n");
    fs.writeFileSync(
      serverScript,
      [
        'const http = require("node:http");',
        "const port = Number(process.env.PORT);",
        "let statusRequests = 0;",
        "const server = http.createServer((request, response) => {",
        '  response.writeHead(200, { "content-type": "application/json" });',
        '  if (request.url === "/api/status") {',
        "    statusRequests += 1;",
        "    const gpp = statusRequests < 3",
        '      ? { installed: false, diagnostic: "Toolchain detection is still in progress." }',
        "      : { installed: true };",
        "    response.end(JSON.stringify({ healthy: true, gpp }));",
        "    return;",
        "  }",
        '  if (request.url.startsWith("/api/fetch-contestants")) { response.end(JSON.stringify({ success: true, data: ["Contestant 2", "Contestant 10"] })); return; }',
        '  if (request.url.startsWith("/api/fetch-problems")) { response.end(JSON.stringify({ success: true, data: ["Problem A", "Problem B"] })); return; }',
        "  response.writeHead(404).end();",
        "});",
        'server.listen(port, "127.0.0.1");',
        "process.stdin.resume();",
        'process.stdin.once("end", () => server.close(() => process.exit(70)));',
      ].join("\n"),
    );

    const status = await smokeTestSidecar(process.execPath, {
      args: [serverScript],
      resourceDirectory: directory,
      requireCpp: true,
      timeoutMs: 5_000,
    });
    assert.deepEqual(status, { healthy: true, gpp: { installed: true } });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sidecar smoke tests reproduce Tauri resource path spelling on Windows", () => {
  assert.equal(
    toTauriResourceDirectory(String.raw`C:\Program Files\JudgeDesk`, "win32"),
    String.raw`\\?\C:\Program Files\JudgeDesk`,
  );
  assert.equal(
    toTauriResourceDirectory(String.raw`\\server\share\JudgeDesk`, "win32"),
    String.raw`\\?\UNC\server\share\JudgeDesk`,
  );
  assert.equal(
    toTauriResourceDirectory("/Applications/JudgeDesk.app/Contents/Resources", "darwin"),
    path.resolve("/Applications/JudgeDesk.app/Contents/Resources"),
  );
});

test("GitHub release workflow verifies tagged source without building platform artifacts", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /name: Verify Release Source/);
  assert.match(workflow, /tags:\s+\- "v\*"/);
  assert.match(workflow, /npm run release:check-version/);
  assert.match(workflow, /npm run test:server/);
  assert.match(workflow, /cargo fmt --check --manifest-path native-executor\/Cargo\.toml/);
  assert.doesNotMatch(workflow, /tauri build/);
  assert.doesNotMatch(workflow, /gh release (create|upload)/);
  assert.doesNotMatch(workflow, /contents: write/);

  const coreMacConfig = JSON.parse(
    fs.readFileSync(
      new URL("../src-tauri/tauri.macos.core.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const fullMacConfig = JSON.parse(
    fs.readFileSync(
      new URL("../src-tauri/tauri.macos.full.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(coreMacConfig.bundle.targets, ["app", "dmg"]);
  assert.equal(coreMacConfig.bundle.createUpdaterArtifacts, false);
  assert.equal(fullMacConfig.bundle.createUpdaterArtifacts, true);
  assert.equal(fullMacConfig.bundle.macOS.entitlements, "./Entitlements.plist");
  const localMacConfig = JSON.parse(
    fs.readFileSync(
      new URL("../src-tauri/tauri.macos.local.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(localMacConfig.bundle.targets, ["app", "dmg"]);
  assert.equal(localMacConfig.bundle.createUpdaterArtifacts, false);
  assert.equal(localMacConfig.bundle.macOS.signingIdentity, "-");
  assert.equal(localMacConfig.bundle.macOS.entitlements, "./Entitlements.plist");
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    packageJson.scripts["build:macos:local"],
    /tauri\.macos\.local\.conf\.json.*aarch64-apple-darwin/,
  );
  assert.match(packageJson.scripts["build:macos:local:headless"], /CI=true/);
  assert.match(packageJson.scripts["build:macos:local:headless"], /verify:macos:local/);
  assert.match(packageJson.scripts["verify:macos:local"], /JUDGEDESK_LOCAL_BUNDLE=1/);
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
  const managedPythonSmoke = fs.readFileSync(
    new URL("./smoke-test-managed-python.ts", import.meta.url),
    "utf8",
  );
  const bundleScript = fs.readFileSync(
    new URL("./verify-macos-arm64-bundle.sh", import.meta.url),
    "utf8",
  );
  const macPlatform = fs.readFileSync(
    new URL("../native-executor/src/platform/macos.rs", import.meta.url),
    "utf8",
  );
  const macLauncher = fs.readFileSync(
    new URL("../native-executor/src/macos_launcher.rs", import.meta.url),
    "utf8",
  );
  const macProcess = fs.readFileSync(
    new URL("../native-executor/src/macos_process.rs", import.meta.url),
    "utf8",
  );
  const macController = fs.readFileSync(
    new URL("../native-executor/src/macos_run_controller.rs", import.meta.url),
    "utf8",
  );
  const macGuardian = fs.readFileSync(
    new URL("../native-executor/src/macos_run_guardian.rs", import.meta.url),
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
  const guardianHarness = fs.readFileSync(
    new URL("../server/executor-tests/macos-run-guardian.integration.test.ts", import.meta.url),
    "utf8",
  );
  const processSupervisorGate = fs.readFileSync(
    new URL("./macos-process-supervisor-gate.sh", import.meta.url),
    "utf8",
  );
  const packagedCheckerGate = fs.readFileSync(
    new URL("./macos-packaged-checker-gate.mjs", import.meta.url),
    "utf8",
  );

  assert.match(sidecarScript, /lipo "\$sidecar" -verify_arch arm64/);
  assert.match(sidecarScript, /smoke-test-sidecar\.js "\$sidecar"/);
  assert.match(sidecarScript, /test:executor/);
  assert.match(sidecarScript, /security\.integration\.test\.ts/);
  assert.match(sidecarScript, /smoke-test-macos-compiler\.ts/);
  assert.match(sidecarScript, /smoke-test-managed-python\.ts/);
  assert.match(sidecarScript, /JUDGEDESK_SMOKE_INSTALL_MANAGED_PYTHON=1/);
  assert.match(
    managedPythonSmoke,
    /prepareIsolatedPythonScript\(\s*workspace,\s*sourcePath,\s*"submission\.py",\s*undefined,\s*managed,\s*\)/,
  );
  assert.match(
    managedPythonSmoke,
    /executorClient\.run\(buildSubmissionExecutorRunSpec\(\{[\s\S]*toolchain: launch\.toolchain/,
  );
  assert.match(
    securityHarness,
    /const managedPython = resolveManagedToolchain\("python"\)/,
  );
  assert.match(
    securityHarness,
    /prepareIsolatedPythonScript\([\s\S]*undefined,\s*managedPython,[\s\S]*buildCheckerExecutorRunSpec\(\{[\s\S]*toolchain: launch\.toolchain/,
  );
  const managedPythonSmokeIndex = sidecarScript.indexOf(
    "npx tsx scripts/smoke-test-managed-python.ts",
  );
  const securityGateIndex = sidecarScript.indexOf(
    "npx tsx --test server/executor-tests/security.integration.test.ts",
  );
  assert.ok(managedPythonSmokeIndex >= 0);
  assert.ok(securityGateIndex > managedPythonSmokeIndex);
  assert.match(
    sidecarScript.slice(Math.max(0, securityGateIndex - 100), securityGateIndex),
    /THEMIS_APP_DATA_DIR="\$python_smoke_data"/,
  );
  assert.match(sidecarScript, /set_limit\(libc::RLIMIT_NPROC/);
  assert.match(sidecarScript, /JUDGEDESK_TREE_GUARD_GENERATION/);
  assert.match(sidecarScript, /JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1/);
  assert.match(sidecarScript, /--test-process-bomb/);
  assert.match(sidecarScript, /kernel process ceiling contains a real process bomb/);
  assert.doesNotMatch(sidecarScript, /macOS diagnostics/);
  assert.match(macLauncher, /libc::wait4/);
  assert.match(macLauncher, /ru_maxrss/);
  assert.match(macLauncher, /set_limit\(libc::RLIMIT_NPROC, limits\.nproc_ceiling\)/);
  assert.match(macLauncher, /PREPARED_BROADCAST_ORDER/);
  assert.match(macProcess, /stop_kill_anchor_group_and_reap/);
  assert.match(macController, /no owned unreaped anchor pin/);
  assert.doesNotMatch(macController, /signal_live_anchor_group/);
  assert.match(macGuardian, /POSIX_SPAWN_CLOEXEC_DEFAULT/);
  assert.match(macPlatform, /startup_process_limit_probe/);
  assert.match(executorMain, /Some\("--test-process-bomb"\)/);
  assert.match(securityHarness, /kernel process ceiling contains a real process bomb/);
  assert.match(securityHarness, /processCount:\s*1/);
  assert.match(securityHarness, /"process_limit"/);
  assert.match(
    guardianHarness,
    /macOS per-run guardian enforces destructive single-fault boundaries/,
  );
  assert.match(
    processSupervisorGate,
    /run_supervisor_command=.*--judgedesk-macos-run-supervisor/,
  );
  assert.match(
    processSupervisorGate,
    /parent_pid "\$candidate_anchor".*candidate_guardian/s,
  );
  assert.doesNotMatch(
    processSupervisorGate,
    /pgrep -P "\$active_executor" \| head -n 1/,
  );
  assert.match(
    processSupervisorGate,
    /port="\$\(wait_for_listening_port "\$active_server"\)"/,
  );
  assert.match(
    processSupervisorGate,
    /replacement_port="\$\(wait_for_listening_port "\$replacement_server"\)"/,
  );
  assert.match(
    processSupervisorGate,
    /final_status=.*secureRunner\?\.ready/s,
  );
  assert.match(packagedCheckerGate, /THEMIS_APP_DATA_DIR: appData/);
  assert.match(packagedCheckerGate, /checker\.cpp/);
  assert.match(packagedCheckerGate, /checker\.py/);
  assert.match(packagedCheckerGate, /\/api\/batch-judge\/cancel/);
  assert.match(packagedCheckerGate, /baselineWorkspaces/);
  assert.match(packagedCheckerGate, /baselineProfiles/);
  assert.match(bundleScript, /hdiutil attach "\$dmg_file" -readonly -nobrowse/);
  assert.match(bundleScript, /trap cleanup_dmg_mount EXIT/);
  assert.match(bundleScript, /JUDGEDESK_TREE_GUARD_GENERATION/);
  assert.match(bundleScript, /JUDGEDESK_LOCAL_BUNDLE/);
  assert.match(bundleScript, /Contents\/MacOS\/themis-v2" -verify_arch arm64/);
  assert.match(bundleScript, /lipo "\$server_binary" -verify_arch arm64/);
  assert.match(bundleScript, /codesign -d --entitlements - "\$server_binary"/);
  assert.match(bundleScript, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(bundleScript, /smoke-test-sidecar\.js/);
  assert.match(bundleScript, /--require-cpp/);
});

test("macOS executor benchmark establishes its guard before loading the client", () => {
  const benchmark = fs.readFileSync(
    new URL("./executor-benchmark.ts", import.meta.url),
    "utf8",
  );
  const provisionIndex = benchmark.indexOf(
    "const ownedMacosTreeGuard = provisionMacosTreeGuard();",
  );
  const clientImportIndex = benchmark.indexOf(
    'import("../server/executor/client.js")',
  );

  assert.ok(provisionIndex >= 0);
  assert.ok(clientImportIndex > provisionIndex);
  assert.doesNotMatch(benchmark, /import \{ executorClient \} from/);
  assert.match(benchmark, /partial macOS process-tree guard environment/);
  assert.match(benchmark, /releaseMacosTreeGuard\(ownedMacosTreeGuard\)/);
});

test("signed toolchain publication targets the public distribution repository", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/toolchains.yml", import.meta.url),
    "utf8",
  );
  const publishJob = workflow.slice(workflow.indexOf("  publish:"));

  assert.match(workflow, /PUBLIC_RELEASE_REPOSITORY: ducminh25\/judgedesk/);
  assert.match(workflow, /TOOLCHAIN_RELEASE_TAG: toolchains-v2/);
  assert.match(publishJob, /GH_TOKEN: \$\{\{ secrets\.PUBLIC_RELEASE_TOKEN \}\}/);
  assert.match(publishJob, /TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64/);
  assert.match(publishJob, /gh release upload "\$TOOLCHAIN_RELEASE_TAG" dist-toolchains\/\*/);
  assert.match(publishJob, /--repo "\$PUBLIC_RELEASE_REPOSITORY"/);
});

test("release contracts stage Core and Full while updater selection remains Full-only", () => {
  const codemagic = fs.readFileSync(
    new URL("../codemagic.yaml", import.meta.url),
    "utf8",
  );
  const macBundleScript = fs.readFileSync(
    new URL("./verify-macos-arm64-bundle.sh", import.meta.url),
    "utf8",
  );
  const updaterManifest = fs.readFileSync(
    new URL("./generate-updater-manifest.js", import.meta.url),
    "utf8",
  );
  assert.match(codemagic, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(codemagic, /JudgeDesk_\*_core_aarch64\.dmg/);
  assert.match(codemagic, /JudgeDesk_\*_full_aarch64\.dmg/);
  assert.match(codemagic, /JudgeDesk_\*_full_aarch64\.app\.tar\.gz\.sig/);
  assert.match(codemagic, /JudgeDesk_\$\{version\}_\$\{variant\}_x64_en-US\.msi/);
  assert.match(macBundleScript, /\.app\.tar\.gz\.sig/);
  assert.match(macBundleScript, /distribution_variant.*core \| full/s);
  assert.match(macBundleScript, /Expected exactly one JudgeDesk DMG/);
  assert.match(macBundleScript, /Expected exactly one macOS updater bundle/);
  assert.match(updaterManifest, /JudgeDesk_\$\{version\}_full_x64_en-US\.msi/);
  assert.match(updaterManifest, /JudgeDesk_\$\{version\}_full_aarch64\.app\.tar\.gz/);
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
  assert.match(codemagic, /JudgeDesk_\*_core_aarch64\.dmg/);
  assert.match(codemagic, /JudgeDesk_\*_full_aarch64\.dmg/);
  assert.match(codemagic, /JudgeDesk_\*_full_aarch64\.app\.tar\.gz\.sig/);
  assert.match(codemagic, /distribution:sync:core/);
  assert.match(codemagic, /distribution:sync:full/);
  assert.match(codemagic, /tauri\.macos\.core\.conf\.json/);
  assert.match(codemagic, /tauri\.macos\.full\.conf\.json/);
  assert.match(codemagic, /JUDGEDESK_DISTRIBUTION_VARIANT=core/);
  assert.match(codemagic, /JUDGEDESK_DISTRIBUTION_VARIANT=full/);
  assert.match(codemagic, /JUDGEDESK_REAL_LANGUAGE_GATES=pascal,java,python/);
  assert.match(codemagic, /test:macos-packaged-checkers/);
  assert.match(codemagic, /test:macos-process-supervisor/);
  const sidecarBuildIndex = codemagic.indexOf("bash scripts/build-macos-arm64-sidecar.sh");
  const tauriTestIndex = codemagic.indexOf(
    "cargo test --locked --manifest-path src-tauri/Cargo.toml",
  );
  assert.ok(sidecarBuildIndex >= 0, "Codemagic must build the Apple Silicon sidecars");
  assert.ok(
    tauriTestIndex > sidecarBuildIndex,
    "Tauri tests must run after the external binaries required by tauri-build exist",
  );
  assert.match(sidecarScript, /TAURI_TARGET=aarch64-apple-darwin/);
  assert.doesNotMatch(sidecarScript, /x86_64/);
  assert.match(sidecarScript, /smoke-test-macos-compiler\.ts/);
  assert.match(bundleScript, /Contents\/MacOS\/themis-v2" -verify_arch arm64/);
  assert.match(bundleScript, /lipo "\$server_binary" -verify_arch arm64/);
  assert.match(bundleScript, /smoke-test-sidecar\.js/);
});

test("Windows release builder creates distinct local Core and Full candidates", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const releaseScript = fs.readFileSync(
    new URL("./build-windows-release-variants.ps1", import.meta.url),
    "utf8",
  );

  assert.match(packageJson.scripts["build:windows:release:local"], /build-windows-release-variants\.ps1/);
  assert.match(releaseScript, /foreach \(\$variant in @\("core", "full"\)\)/);
  assert.match(releaseScript, /tauri\.windows\.\$variant\.local\.conf\.json/);
  assert.match(releaseScript, /JudgeDesk_\$\{version\}_\$\{variant\}_x64_en-US\.msi/);
  assert.match(releaseScript, /Get-AuthenticodeSignature/);
  assert.match(releaseScript, /SHA256SUMS-windows/);
  assert.match(releaseScript, /\$repoChildPrefix/);
  assert.match(
    releaseScript,
    /\$outputRoot\.StartsWith\(\$repoChildPrefix,[\s\S]*OrdinalIgnoreCase/,
  );
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
  assert.match(signingWorkflow, /for variant in core full/);
  assert.match(signingWorkflow, /JudgeDesk_\$\{version\}_\$\{variant\}_x64_en-US\.msi/);
  assert.match(signingWorkflow, /WINDOWS_CORE_MSI_SHA256/);
  assert.match(signingWorkflow, /WINDOWS_FULL_MSI_SHA256/);
  assert.ok(
    signingWorkflow.indexOf("SHA-256 mismatch")
      < signingWorkflow.indexOf("tauri signer sign"),
    "staged hashes must be checked before the updater key signs either MSI",
  );
  assert.match(signingWorkflow, /tauri signer sign/);
  assert.match(signingWorkflow, /JudgeDesk_\*\.msi\.sig/);
});
