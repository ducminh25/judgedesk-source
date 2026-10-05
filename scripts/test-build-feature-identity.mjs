// Explicit integration gate: real Cargo builds and loopback startup/status/stream probes.
// Keep synthetic source and targets out of the application's production caches.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const [outputDirectory, profileSelection = "all"] = process.argv.slice(2);
assert.ok(outputDirectory, "provide a fresh evidence directory");
assert.ok(["all", "packaged"].includes(profileSelection), "profile selection must be all or packaged");
assert.ok(process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64"), "supported live host required");
const output = path.resolve(outputDirectory);
assert.ok(!fs.existsSync(output), "evidence directory must not already exist");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd-feature-identity-"));
const owner = crypto.randomUUID();
fs.writeFileSync(path.join(root, ".owner"), owner);
const records = [];
const runtimes = [];
const environment = { ...process.env, CARGO_TARGET_DIR: path.join(root, "target") };
for (const name of Object.keys(environment)) {
  if (name.startsWith("CARGO_FEATURE_") || name.startsWith("JUDGEDESK_BUILD_") ||
      ["JUDGEDESK_APP_VERSION", "JUDGEDESK_GIT_COMMIT", "SOURCE_DATE_EPOCH"].includes(name)) delete environment[name];
}
const target = process.platform === "win32" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function run(name, command, args, env = environment) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, `${name}.log`), (result.stdout || "") + (result.stderr || ""));
  records.push({ name, command: [command, ...args], cwd: root, startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started, exitCode: result.status,
    environment: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("CARGO_FEATURE_") ||
      key.startsWith("JUDGEDESK_BUILD_") || ["CARGO_TARGET_DIR", "JUDGEDESK_APP_VERSION", "JUDGEDESK_GIT_COMMIT", "SOURCE_DATE_EPOCH"].includes(key))) });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}

async function rebind(port) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(port, "127.0.0.1", resolve); });
  await new Promise((resolve) => listener.close(resolve));
}

async function probe(name, binary, expected) {
  const live = fs.mkdtempSync(path.join(root, "runtime-"));
  let stdout = "", stderr = "", exit = null, port = null;
  const runtime = { name, binary, binarySha256: hash(binary), expected, startedAt: new Date().toISOString() };
  runtimes.push(runtime);
  const child = spawn(binary, [], { cwd: live, env: { ...environment, PORT: "0", LOCALAPPDATA: live, APPDATA: live,
    TEMP: live, TMP: live, TMPDIR: live, THEMIS_APP_DATA_DIR: path.join(live, "data"), THEMIS_RESOURCE_DIR: live,
    JUDGEDESK_EXECUTOR_PATH: "", JUDGEDESK_TEST_EXECUTOR_PATH: "", JUDGEDESK_APP_VERSION: "runtime-spoof",
    JUDGEDESK_BUILD_MODE: "runtime-spoof", JUDGEDESK_GIT_COMMIT: "runtime-spoof" }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => { exit = { code, signal }; resolve(exit); });
  });
  child.stdout.on("data", (data) => stdout += data);
  child.stderr.on("data", (data) => stderr += data);
  try {
    const started = Date.now();
    while (Date.now() - started < 20000 && !exit) {
      const match = stdout.match(/JUDGEDESK_CORE_PORT=(\d+)/);
      if (match) { port = Number(match[1]); break; }
      await pause(50);
    }
    assert.ok(port, `startup missing: ${stdout}\n${stderr}`);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) })).json();
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("JUDGEDESK_BUILD_IDENTITY="));
    assert.ok(line, "startup identity missing");
    runtime.build = status.build;
    if (process.platform === "win32") {
      const bytes = fs.readFileSync(binary);
      const pe = bytes.readUInt32LE(0x3c);
      assert.equal(bytes.readUInt32LE(pe), 0x4550, "PE signature");
      assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, "actual Windows x64 executable");
      runtime.architecture = "x86_64";
    } else {
      runtime.architecture = run(`${name}-architecture`, "/usr/bin/file", ["-b", binary]);
      assert.match(runtime.architecture, /arm64/, "actual macOS arm64 executable");
    }
    runtime.startup = JSON.parse(line.slice("JUDGEDESK_BUILD_IDENTITY=".length));
    assert.deepEqual(runtime.startup, runtime.build, "startup/status differ");
    const streamed = await fetch(`http://127.0.0.1:${port}/api/batch-judge`, { method: "POST",
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ thisinhPath: path.join(live, "empty-contestants"), testPath: path.join(live, "empty-problems") }) });
    assert.equal(streamed.status, 200);
    const events = (await streamed.text()).trim().split("\n").map((item) => JSON.parse(item));
    assert.equal(events[0].type, "metadata");
    runtime.streamBuild = events[0].data.build;
    assert.deepEqual(runtime.streamBuild, runtime.build, "stream/status differ");
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(runtime.build[key], value, `${name}: ${key}`);
    const stopped = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(5000) });
    assert.equal(stopped.status, 200); await stopped.text();
    assert.deepEqual(await Promise.race([exited, pause(5000).then(() => null)]), { code: 0, signal: null });
    runtime.status = "PASS";
  } catch (error) {
    runtime.status = "FAIL"; runtime.error = error.stack; throw error;
  } finally {
    if (!exit) { child.kill("SIGTERM"); await Promise.race([exited, pause(3000)]); }
    if (!exit) { child.kill("SIGKILL"); await Promise.race([exited, pause(3000)]); }
    assert.ok(exit, "owned process did not drain");
    runtime.exit = exit; runtime.port = port;
    if (port) { await rebind(port); runtime.portReleased = true; }
    fs.writeFileSync(path.join(output, `${name}-startup.log`), stdout + stderr);
    fs.rmSync(live, { recursive: true }); runtime.rootRemoved = !fs.existsSync(live);
    fs.writeFileSync(path.join(output, `${name}-runtime.json`), JSON.stringify(runtime, null, 2));
  }
}

async function buildProbe(name, expected, flags = [], forged = {}, binaryName = "server") {
  run(`${name}-build`, "cargo", ["build", "--locked", "--manifest-path", "crates/judgedesk-core/Cargo.toml", "--bin", binaryName, ...flags], { ...environment, ...forged });
  const profile = flags.includes("--release") ? "release" : "debug";
  await probe(name, path.join(root, "target", profile, binaryName + (process.platform === "win32" ? ".exe" : "")),
    { appVersion, backend: "rust", target, ...expected });
}

let failure;
try {
  for (const dir of ["crates/judgedesk-core", "native-executor", "src-tauri", "scripts", "src"]) {
    fs.cpSync(path.join(repo, dir), path.join(root, dir), { recursive: true,
      filter: (source) => !["target", "node_modules", "binaries"].includes(path.basename(source)) });
  }
  for (const file of ["package.json", "package-lock.json", ".nvmrc", "rust-toolchain.toml"]) fs.copyFileSync(path.join(repo, file), path.join(root, file));
  const inputs = [];
  function recordInputs(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const copied = path.join(directory, item.name);
      if (item.isDirectory()) recordInputs(copied);
      else if (item.name !== ".owner") {
        assert.ok(item.isFile(), "source fixture must contain regular files");
        const relative = path.relative(root, copied);
        assert.equal(hash(copied), hash(path.join(repo, relative)), `copied source differs: ${relative}`);
        inputs.push({ path: relative.replaceAll(path.sep, "/"), bytes: fs.statSync(copied).size, sha256: hash(copied) });
      }
    }
  }
  recordInputs(root);
  fs.writeFileSync(path.join(output, "fixture-inputs.json"), JSON.stringify(inputs, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), "target/\n**/target/\n");
  run("git-init", "git", ["init"]); run("git-add", "git", ["add", "."]);
  run("git-commit", "git", ["-c", "user.name=identity fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "owned fixture"]);
  let head = run("head-initial", "git", ["rev-parse", "HEAD"]);
  const dev = () => ({ gitCommit: head, sourceState: "clean", buildMode: "development", builtAt: "development", features: ["default"] });
  await buildProbe("dev-clean", dev());
  fs.writeFileSync(path.join(root, "untracked-input"), "dirty");
  await buildProbe("dev-dirty", { ...dev(), sourceState: "dirty" });
  fs.rmSync(path.join(root, "untracked-input")); await buildProbe("dev-restored", dev());
  run("git-next", "git", ["-c", "user.name=identity fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "next"]);
  const next = run("head-next", "git", ["rev-parse", "HEAD"]); assert.notEqual(head, next); head = next;
  await buildProbe("dev-head", dev());
  await buildProbe("dev-no-default", { ...dev(), features: [] }, ["--no-default-features"]);
  await buildProbe("dev-test-server", { ...dev(), features: ["default", "test-server"] }, ["--features", "test-server"], {}, "test-server");
  const forged = { CARGO_FEATURE_DEFAULT: "0", CARGO_FEATURE_TEST_SERVER: "1", CARGO_FEATURE_UNDECLARED: "1" };
  for (const profile of profileSelection === "packaged" ? ["packaged"] : ["development", "packaged"]) {
    if (profile === "packaged") Object.assign(environment, { JUDGEDESK_BUILD_MODE: "packaged", JUDGEDESK_APP_VERSION: appVersion,
      JUDGEDESK_GIT_COMMIT: head, JUDGEDESK_BUILD_SOURCE_STATE: "clean",
      JUDGEDESK_BUILD_NUMBER: "wp06-log0091", SOURCE_DATE_EPOCH: "1790399550" });
    const expected = profile === "development" ? dev() : { features: ["default"], buildMode: "packaged", sourceState: "clean",
      gitCommit: environment.JUDGEDESK_GIT_COMMIT, buildNumber: "wp06-log0091", builtAt: "2026-09-26T05:12:30.000Z" };
    const flags = profile === "packaged" ? ["--release"] : [];
    await buildProbe(`${profile}-control`, expected, flags);
    await buildProbe(`${profile}-forged-default`, expected, flags, forged);
    await buildProbe(`${profile}-forged-no-default`, { ...expected, features: [] }, [...flags, "--no-default-features"], forged);
    await buildProbe(`${profile}-enabled-misleading`, { ...expected, features: ["default", "test-server"] }, [...flags, "--features", "test-server"],
      { ...forged, CARGO_FEATURE_TEST_SERVER: "0" }, "test-server");
    await buildProbe(`${profile}-no-default-enabled`, { ...expected, features: ["test-server"] }, [...flags, "--no-default-features", "--features", "test-server"],
      { ...forged, CARGO_FEATURE_TEST_SERVER: "" }, "test-server");
  }
  // Same target/profile: provenance-only rebuild, followed by release -> development transition.
  environment.JUDGEDESK_BUILD_NUMBER = "wp06-log0091-next";
  await buildProbe("packaged-metadata-refresh", { features: ["default"], buildMode: "packaged", sourceState: "clean",
    gitCommit: environment.JUDGEDESK_GIT_COMMIT, buildNumber: environment.JUDGEDESK_BUILD_NUMBER, builtAt: "2026-09-26T05:12:30.000Z" }, ["--release"], forged);
  for (const key of Object.keys(environment)) if (key.startsWith("JUDGEDESK_BUILD_") || ["JUDGEDESK_APP_VERSION", "JUDGEDESK_GIT_COMMIT", "SOURCE_DATE_EPOCH"].includes(key)) delete environment[key];
  await buildProbe("release-development-transition", dev(), ["--release"], forged);
} catch (error) { failure = error; }
finally {
  assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  assert.equal(fs.readFileSync(path.join(root, ".owner"), "utf8"), owner);
  fs.rmSync(root, { recursive: true });
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ status: failure ? "FAIL" : "PASS", error: failure?.stack,
    host: { os: process.platform, arch: process.arch }, records, runtimes, ownedRoot: root, rootRemoved: !fs.existsSync(root) }, null, 2));
}
if (failure) throw failure;
console.log(`PASS: ${runtimes.length} real build/startup/status/stream cases; owned source and targets removed`);
