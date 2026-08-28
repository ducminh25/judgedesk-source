import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CPP_LANGUAGE_PROFILE_ID,
  LANGUAGE_REGISTRY_REVISION,
  listRegisteredLanguageProfiles,
} from "../languages/registry.js";
import type { ToolchainKind } from "./types.js";
import {
  loadToolchainPreferenceSnapshot,
  updateProfileToolchainPreference,
} from "./storage.js";
import {
  getDiscoveredCandidates,
  getToolchainDiscoveryAttempts,
  getToolchainDiscoveryFilePath,
  getToolchainDiscoverySnapshot,
  resetToolchainDiscoveryRuntimeForTests,
  setToolchainDiscoveryProbeForTests,
  setToolchainDiscoveryStandardCandidatesForTests,
  startInitialToolchainDiscovery,
  waitForToolchainDiscovery,
  type ToolchainVersionProbeOutput,
  type ToolchainVersionProbeRequest,
} from "./discovery.js";

interface DiscoveryFixture {
  root: string;
  bin: string;
}

function useDiscoveryFixture(t: TestContext): DiscoveryFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-discovery-v2-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const keys = [
    "THEMIS_APP_DATA_DIR",
    "PATH",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "LOCALAPPDATA",
    "USERPROFILE",
    "JAVA_HOME",
    "GOROOT",
    "DOTNET_ROOT",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.THEMIS_APP_DATA_DIR = path.join(root, "app-data");
  process.env.PATH = bin;
  process.env.ProgramFiles = path.join(root, "Program Files");
  process.env["ProgramFiles(x86)"] = path.join(root, "Program Files (x86)");
  process.env.LOCALAPPDATA = path.join(root, "LocalAppData");
  process.env.USERPROFILE = path.join(root, "UserProfile");
  delete process.env.JAVA_HOME;
  delete process.env.GOROOT;
  delete process.env.DOTNET_ROOT;
  setToolchainDiscoveryProbeForTests(undefined);
  setToolchainDiscoveryStandardCandidatesForTests(async () => []);
  resetToolchainDiscoveryRuntimeForTests();
  t.after(() => {
    setToolchainDiscoveryProbeForTests(undefined);
    setToolchainDiscoveryStandardCandidatesForTests(undefined);
    resetToolchainDiscoveryRuntimeForTests();
    fs.rmSync(root, { recursive: true, force: true });
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { root, bin };
}

function executableName(base: string): string {
  return os.platform() === "win32" ? `${base}.exe` : base;
}

function createExecutable(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "discovery fixture\n");
  if (os.platform() !== "win32") fs.chmodSync(filePath, 0o700);
  return fs.realpathSync.native(filePath);
}

function successfulOutput(kind: ToolchainKind): ToolchainVersionProbeOutput {
  const output: Record<ToolchainKind, ToolchainVersionProbeOutput> = {
    cpp: {
      stdout: "",
      stderr: "gcc version 14.2.0 (WinLibs)\nTarget: x86_64-w64-mingw32\n",
    },
    c: {
      stdout: "",
      stderr: "gcc version 14.2.0 (WinLibs)\nTarget: x86_64-w64-mingw32\n",
    },
    python: { stdout: "Python 3.12.13\n", stderr: "" },
    pascal: { stdout: "3.2.2\n", stderr: "" },
    go: { stdout: "go version go1.26.5 windows/amd64\n", stderr: "" },
    java: { stdout: "javac 21.0.12\n", stderr: "" },
    rust: { stdout: "rustc 1.97.1\nhost: x86_64-pc-windows-msvc\n", stderr: "" },
    javascript: { stdout: "v24.18.1\n", stderr: "" },
    csharp: { stdout: "10.0.302\n", stderr: "" },
    scratch: { stdout: "0.1.7\n", stderr: "" },
  };
  return output[kind];
}

function stageEveryLanguage(bin: string): void {
  const names: Record<ToolchainKind, string> = {
    cpp: "g++",
    c: "gcc",
    python: "python3",
    pascal: "fpc",
    go: "go",
    java: "javac",
    rust: "rustc",
    javascript: "node",
    csharp: "dotnet",
    scratch: "scratch-run",
  };
  for (const name of Object.values(names)) {
    createExecutable(path.join(bin, executableName(name)));
  }
}

test("cached v2 state is returned immediately and refreshed once on every launch", async (t) => {
  const { root, bin } = useDiscoveryFixture(t);
  const firstPath = createExecutable(path.join(bin, executableName("g++")));
  setToolchainDiscoveryProbeForTests(async (request) => successfulOutput(request.kind));
  startInitialToolchainDiscovery();
  const first = await waitForToolchainDiscovery();
  assert.equal(first.status, "complete");
  assert.equal(first.refreshing, false);
  assert.equal(getDiscoveredCandidates("cpp")[0]?.canonicalPath, firstPath);

  fs.rmSync(firstPath);
  const secondBin = path.join(root, "second-bin");
  fs.mkdirSync(secondBin);
  const secondPath = createExecutable(path.join(secondBin, executableName("g++")));
  process.env.PATH = secondBin;
  let releaseProbe!: () => void;
  let markProbeStarted!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });
  let probeCalls = 0;
  setToolchainDiscoveryProbeForTests(async (request) => {
    probeCalls += 1;
    markProbeStarted();
    await probeGate;
    return successfulOutput(request.kind);
  });
  resetToolchainDiscoveryRuntimeForTests();

  assert.equal(getToolchainDiscoverySnapshot().status, "complete");
  assert.equal(probeCalls, 0, "reading cached state must not spawn a probe");
  assert.equal(getDiscoveredCandidates("cpp")[0]?.canonicalPath, firstPath);
  startInitialToolchainDiscovery();
  const refreshing = getToolchainDiscoverySnapshot();
  assert.equal(refreshing.status, "complete");
  assert.equal(refreshing.refreshing, true);
  assert.equal(getDiscoveredCandidates("cpp")[0]?.canonicalPath, firstPath);
  await probeStarted;
  assert.equal(probeCalls, 1);
  releaseProbe();
  const refreshed = await waitForToolchainDiscovery();
  assert.equal(refreshed.status, "complete");
  assert.equal(getDiscoveredCandidates("cpp")[0]?.canonicalPath, secondPath);
});

test("PATH order determines candidate priority and discovers all PATH candidates", async (t) => {
  const { root } = useDiscoveryFixture(t);
  const firstBin = path.join(root, "path-0");
  const secondBin = path.join(root, "path-1");
  const first = createExecutable(path.join(firstBin, executableName("g++")));
  const second = createExecutable(path.join(secondBin, executableName("g++")));
  process.env.PATH = [firstBin, secondBin].join(path.delimiter);
  const probes: ToolchainVersionProbeRequest[] = [];
  const standardKinds: ToolchainKind[] = [];
  setToolchainDiscoveryProbeForTests(async (request) => {
    probes.push(request);
    return successfulOutput(request.kind);
  });
  setToolchainDiscoveryStandardCandidatesForTests(async (kind) => {
    standardKinds.push(kind);
    return [];
  });

  startInitialToolchainDiscovery();
  await waitForToolchainDiscovery();
  const candidates = getDiscoveredCandidates("cpp");
  assert.equal(candidates[0]?.canonicalPath, first);
  assert.equal(candidates[0]?.origin, "path");
  assert.equal(candidates[0]?.pathRank, 0);
  assert.equal(candidates[1]?.canonicalPath, second);
  assert.equal(candidates[1]?.origin, "path");
  assert.equal(candidates[1]?.pathRank, 1);
  assert.deepEqual(probes.filter((probe) => probe.kind === "cpp").map(
    (probe) => probe.executablePath,
  ), [first, second]);
  assert.deepEqual(probes.find((probe) => probe.kind === "cpp")?.args, ["-v"]);
  assert.deepEqual(standardKinds.filter((kind) => kind === "cpp"), ["cpp"]);
});

test("an explicit local path is probed before PATH and retained in the cache", async (t) => {
  const { root, bin } = useDiscoveryFixture(t);
  const pathCompiler = createExecutable(path.join(bin, executableName("g++")));
  const selectedCompiler = createExecutable(path.join(
    root,
    "chosen toolchain",
    "bin",
    executableName("g++"),
  ));
  loadToolchainPreferenceSnapshot();
  updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, {
    mode: "local_path",
    localPath: selectedCompiler,
  });
  const probes: ToolchainVersionProbeRequest[] = [];
  setToolchainDiscoveryProbeForTests(async (request) => {
    probes.push(request);
    return successfulOutput(request.kind);
  });

  startInitialToolchainDiscovery();
  await waitForToolchainDiscovery();

  const candidates = getDiscoveredCandidates("cpp");
  const selected = candidates[0];
  assert.equal(selected?.canonicalPath, selectedCompiler);
  assert.equal(selected?.origin, "selected-path");
  assert.equal(selected?.pathRank, null);
  assert.deepEqual(
    probes.filter((probe) => probe.kind === "cpp").map((probe) => probe.executablePath),
    [selectedCompiler, pathCompiler],
  );
  assert.notEqual(selected?.canonicalPath, pathCompiler);
});

test("a broken PATH candidate is recorded before the next PATH candidate succeeds", async (t) => {
  const { root } = useDiscoveryFixture(t);
  const firstBin = path.join(root, "path-0");
  const secondBin = path.join(root, "path-1");
  const broken = createExecutable(path.join(firstBin, executableName("g++")));
  const working = createExecutable(path.join(secondBin, executableName("g++")));
  process.env.PATH = [firstBin, secondBin].join(path.delimiter);
  setToolchainDiscoveryProbeForTests(async (request) => {
    if (request.executablePath === broken) throw new Error("simulated launch failure");
    return successfulOutput(request.kind);
  });

  startInitialToolchainDiscovery();
  await waitForToolchainDiscovery();
  const attempts = getToolchainDiscoveryAttempts("cpp");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].canonicalPath, broken);
  assert.equal(attempts[0].pathRank, 0);
  assert.match(attempts[0].error || "", /simulated launch failure/);
  assert.equal(attempts[1].canonicalPath, working);
  assert.equal(attempts[1].pathRank, 1);
  assert.equal(attempts[1].error, null);
});

test("standard locations are consulted only after all PATH probes fail", async (t) => {
  const { root, bin } = useDiscoveryFixture(t);
  const broken = createExecutable(path.join(bin, executableName("g++")));
  const standard = createExecutable(
    path.join(root, "standard", executableName("g++")),
  );
  setToolchainDiscoveryProbeForTests(async (request) => {
    if (request.executablePath === broken) throw new Error("broken PATH compiler");
    return successfulOutput(request.kind);
  });
  setToolchainDiscoveryStandardCandidatesForTests(async (kind) =>
    kind === "cpp" ? [standard] : []
  );

  startInitialToolchainDiscovery();
  await waitForToolchainDiscovery();
  const attempts = getToolchainDiscoveryAttempts("cpp");
  assert.deepEqual(attempts.map((candidate) => candidate.origin), [
    "path",
    "standard-location",
  ]);
  assert.equal(attempts[1].canonicalPath, standard);
  assert.equal(attempts[1].pathRank, null);
  assert.equal(getDiscoveredCandidates("cpp")[0]?.canonicalPath, standard);
});

test("language profiles probe concurrently and persist parsed metadata", async (t) => {
  const { bin } = useDiscoveryFixture(t);
  stageEveryLanguage(bin);
  let active = 0;
  let maximumActive = 0;
  setToolchainDiscoveryProbeForTests(async (request) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 35));
    active -= 1;
    return successfulOutput(request.kind);
  });

  startInitialToolchainDiscovery();
  const completed = await waitForToolchainDiscovery();
  assert.equal(completed.status, "complete");
  assert.equal(
    maximumActive,
    listRegisteredLanguageProfiles().length,
    `expected every registered profile to probe in parallel, saw ${maximumActive}`,
  );
  assert.equal(getDiscoveredCandidates("cpp")[0]?.family, "gnu-gcc");
  assert.equal(getDiscoveredCandidates("cpp")[0]?.version, "14.2.0");
  assert.equal(
    getDiscoveredCandidates("cpp")[0]?.target,
    "x86_64-w64-mingw32",
  );
  assert.equal(getDiscoveredCandidates("java")[0]?.family, "java");
  assert.equal(
    getDiscoveredCandidates("pascal")[0]?.version,
    "3.2.2",
  );

  const stored = JSON.parse(fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.registryRevision, LANGUAGE_REGISTRY_REVISION);
  assert.equal(stored.refreshing, false);
  const storedCpp = stored.profiles[CPP_LANGUAGE_PROFILE_ID][0];
  for (const key of [
    "canonicalPath",
    "origin",
    "pathRank",
    "family",
    "version",
    "target",
    "lastSeenAt",
    "error",
  ]) {
    assert.ok(Object.hasOwn(storedCpp, key), `missing persisted ${key}`);
  }
});

test("one hanging executable is bounded and does not serialize other languages", async (t) => {
  const { bin } = useDiscoveryFixture(t);
  createExecutable(path.join(bin, executableName("g++")));
  createExecutable(path.join(bin, executableName("python3")));
  let pythonFinished = false;
  setToolchainDiscoveryProbeForTests(async (request) => {
    if (request.kind === "cpp") return new Promise(() => {});
    pythonFinished = true;
    return successfulOutput(request.kind);
  });

  const started = Date.now();
  startInitialToolchainDiscovery();
  const completed = await waitForToolchainDiscovery();
  const elapsed = Date.now() - started;
  assert.equal(completed.status, "complete");
  assert.equal(pythonFinished, true);
  assert.ok(elapsed < 1_200, `discovery exceeded its bounded timeout: ${elapsed}ms`);
  assert.match(getToolchainDiscoveryAttempts("cpp")[0]?.error || "", /probe_timeout/);
  assert.equal(getDiscoveredCandidates("python")[0]?.version, "3.12.13");
});

test("malformed v2 cache fails closed on read but every launch repairs it in background", async (t) => {
  const { bin } = useDiscoveryFixture(t);
  createExecutable(path.join(bin, executableName("g++")));
  const malformed = {
    schemaVersion: 2,
    registryRevision: LANGUAGE_REGISTRY_REVISION,
    status: "complete",
    refreshing: false,
    completedAt: "2026-08-02T00:00:00.000Z",
    profiles: Object.fromEntries(
      listRegisteredLanguageProfiles().map((entry) => [entry.profile.ref.id, []]),
    ),
  };
  malformed.profiles[CPP_LANGUAGE_PROFILE_ID] = [{
    candidateId: "a".repeat(24),
    profileId: CPP_LANGUAGE_PROFILE_ID,
    kind: "cpp",
    canonicalPath: path.resolve("missing-metadata"),
    displayPath: path.resolve("missing-metadata"),
    origin: "path",
  }];
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  fs.writeFileSync(getToolchainDiscoveryFilePath(), `${JSON.stringify(malformed)}\n`);
  resetToolchainDiscoveryRuntimeForTests();
  setToolchainDiscoveryProbeForTests(async (request) => successfulOutput(request.kind));

  const failed = getToolchainDiscoverySnapshot();
  assert.equal(failed.status, "failed");
  assert.equal(failed.refreshing, false);
  startInitialToolchainDiscovery();
  assert.equal(getToolchainDiscoverySnapshot().status, "running");
  const repaired = await waitForToolchainDiscovery();
  assert.equal(repaired.status, "complete");
  assert.equal(getDiscoveredCandidates("cpp").length, 1);
});
