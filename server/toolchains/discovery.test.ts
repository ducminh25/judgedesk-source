import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CPP_LANGUAGE_PROFILE_ID,
  JAVA_LANGUAGE_PROFILE_ID,
  LANGUAGE_REGISTRY_REVISION,
  PYTHON_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
} from "../languages/registry.js";
import {
  getToolchainDiscoveryFilePath,
  getToolchainDiscoverySnapshot,
  requestToolchainRescan,
  resetToolchainDiscoveryRuntimeForTests,
  startInitialToolchainDiscovery,
  waitForToolchainDiscovery,
} from "./discovery.js";

function useDiscoveryFixture(t: TestContext): { root: string; bin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-discovery-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const previous = {
    appData: process.env.THEMIS_APP_DATA_DIR,
    path: process.env.PATH,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env["ProgramFiles(x86)"],
    localAppData: process.env.LOCALAPPDATA,
    userProfile: process.env.USERPROFILE,
  };
  process.env.THEMIS_APP_DATA_DIR = path.join(root, "app-data");
  process.env.PATH = bin;
  process.env.ProgramFiles = path.join(root, "Program Files");
  process.env["ProgramFiles(x86)"] = path.join(root, "Program Files (x86)");
  process.env.LOCALAPPDATA = path.join(root, "LocalAppData");
  process.env.USERPROFILE = path.join(root, "UserProfile");
  resetToolchainDiscoveryRuntimeForTests();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      const environmentKey = key === "appData"
        ? "THEMIS_APP_DATA_DIR"
        : key === "path"
          ? "PATH"
          : key === "programFiles"
            ? "ProgramFiles"
            : key === "programFilesX86"
              ? "ProgramFiles(x86)"
              : key === "localAppData"
                ? "LOCALAPPDATA"
                : "USERPROFILE";
      if (value === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = value;
    }
    resetToolchainDiscoveryRuntimeForTests();
  });
  return { root, bin };
}

function executableName(base: string): string {
  return os.platform() === "win32" ? `${base}.exe` : base;
}

function createExecutable(filePath: string): void {
  fs.writeFileSync(filePath, "passive discovery fixture\n");
  if (os.platform() !== "win32") fs.chmodSync(filePath, 0o700);
}

test("initial discovery is passive, persisted, and not repeated on the next app start", async (t) => {
  const { root, bin } = useDiscoveryFixture(t);
  const first = path.join(bin, executableName("g++"));
  createExecutable(first);
  const firstCanonical = fs.realpathSync(first);
  startInitialToolchainDiscovery();
  const completed = await waitForToolchainDiscovery();
  assert.equal(completed.status, "complete");
  assert.ok(
    completed.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === firstCanonical,
    ),
  );
  assert.ok(fs.existsSync(getToolchainDiscoveryFilePath()));

  fs.rmSync(first);
  const secondBin = path.join(root, "second-bin");
  fs.mkdirSync(secondBin);
  const second = path.join(secondBin, executableName("g++"));
  createExecutable(second);
  process.env.PATH = secondBin;
  resetToolchainDiscoveryRuntimeForTests();
  startInitialToolchainDiscovery();
  const restored = getToolchainDiscoverySnapshot();
  assert.equal(restored.status, "complete");
  assert.ok(
    restored.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === firstCanonical,
    ),
  );
  assert.equal(
    restored.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === fs.realpathSync(second),
    ),
    false,
  );
});

test("an explicit rescan replaces the passive candidate snapshot", async (t) => {
  const { root, bin } = useDiscoveryFixture(t);
  const first = path.join(bin, executableName("g++"));
  createExecutable(first);
  startInitialToolchainDiscovery();
  await waitForToolchainDiscovery();

  fs.rmSync(first);
  const secondBin = path.join(root, "second-bin");
  fs.mkdirSync(secondBin);
  const second = path.join(secondBin, executableName("g++"));
  createExecutable(second);
  process.env.PATH = secondBin;
  requestToolchainRescan();
  const rescanned = await waitForToolchainDiscovery();
  assert.equal(rescanned.status, "complete");
  assert.ok(
    rescanned.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === fs.realpathSync(second),
    ),
  );
});

test("corrupt discovery state fails closed until the user explicitly rescans", async (t) => {
  const { bin } = useDiscoveryFixture(t);
  createExecutable(path.join(bin, executableName("g++")));
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  fs.writeFileSync(getToolchainDiscoveryFilePath(), "{invalid");
  resetToolchainDiscoveryRuntimeForTests();
  startInitialToolchainDiscovery();
  assert.equal(getToolchainDiscoverySnapshot().status, "failed");
  assert.equal(fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"), "{invalid");

  requestToolchainRescan();
  assert.equal((await waitForToolchainDiscovery()).status, "complete");
});

test("a valid stale registry snapshot is refreshed once and persisted at the current revision", async (t) => {
  const { root, bin } = useDiscoveryFixture(t);
  const compiler = path.join(bin, executableName("g++"));
  createExecutable(compiler);
  const compilerCanonicalPath = fs.realpathSync(compiler);
  const staleSnapshot = {
    schemaVersion: 1,
    registryRevision: 1,
    status: "complete",
    completedAt: "2026-01-01T00:00:00.000Z",
    profiles: {
      [CPP_LANGUAGE_PROFILE_ID]: [],
      [PYTHON_LANGUAGE_PROFILE_ID]: [],
    },
  };
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  fs.writeFileSync(
    getToolchainDiscoveryFilePath(),
    `${JSON.stringify(staleSnapshot, null, 2)}\n`,
  );
  resetToolchainDiscoveryRuntimeForTests();

  startInitialToolchainDiscovery();
  assert.equal(getToolchainDiscoverySnapshot().status, "running");
  const refreshed = await waitForToolchainDiscovery();
  assert.equal(refreshed.status, "complete");
  assert.equal(refreshed.registryRevision, LANGUAGE_REGISTRY_REVISION);
  assert.deepEqual(
    Object.keys(refreshed.profiles).sort(),
    listRegisteredLanguageProfiles().map((entry) => entry.profile.ref.id).sort(),
  );
  assert.ok(
    refreshed.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === compilerCanonicalPath,
    ),
  );
  const persisted = JSON.parse(
    fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"),
  ) as { registryRevision?: number; profiles?: Record<string, unknown> };
  assert.equal(persisted.registryRevision, LANGUAGE_REGISTRY_REVISION);
  assert.deepEqual(
    Object.keys(persisted.profiles || {}).sort(),
    listRegisteredLanguageProfiles().map((entry) => entry.profile.ref.id).sort(),
  );

  fs.rmSync(compiler);
  const secondBin = path.join(root, "second-bin");
  fs.mkdirSync(secondBin);
  const secondCompiler = path.join(secondBin, executableName("g++"));
  createExecutable(secondCompiler);
  process.env.PATH = secondBin;
  resetToolchainDiscoveryRuntimeForTests();
  startInitialToolchainDiscovery();
  const restored = getToolchainDiscoverySnapshot();
  assert.equal(restored.status, "complete");
  assert.ok(
    restored.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === compilerCanonicalPath,
    ),
  );
  assert.equal(
    restored.profiles[CPP_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === fs.realpathSync(secondCompiler),
    ),
    false,
  );
});

test("an incomplete current registry snapshot fails closed until explicit rescan", async (t) => {
  useDiscoveryFixture(t);
  const incompleteSnapshot = {
    schemaVersion: 1,
    registryRevision: LANGUAGE_REGISTRY_REVISION,
    status: "complete",
    completedAt: "2026-01-01T00:00:00.000Z",
    profiles: {
      [CPP_LANGUAGE_PROFILE_ID]: [],
    },
  };
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  const storedBytes = `${JSON.stringify(incompleteSnapshot, null, 2)}\n`;
  fs.writeFileSync(getToolchainDiscoveryFilePath(), storedBytes);
  resetToolchainDiscoveryRuntimeForTests();

  startInitialToolchainDiscovery();
  const failed = getToolchainDiscoverySnapshot();
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.equal(failed.errorCode, "DISCOVERY_STATE_INVALID");
  }
  assert.equal(fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"), storedBytes);

  requestToolchainRescan();
  const recovered = await waitForToolchainDiscovery();
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.registryRevision, LANGUAGE_REGISTRY_REVISION);
});

test("a future registry snapshot fails closed", (t) => {
  useDiscoveryFixture(t);
  const futureSnapshot = {
    schemaVersion: 1,
    registryRevision: LANGUAGE_REGISTRY_REVISION + 1,
    status: "complete",
    completedAt: "2026-01-01T00:00:00.000Z",
    profiles: Object.fromEntries(
      listRegisteredLanguageProfiles().map((entry) => [entry.profile.ref.id, []]),
    ),
  };
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  const storedBytes = `${JSON.stringify(futureSnapshot, null, 2)}\n`;
  fs.writeFileSync(getToolchainDiscoveryFilePath(), storedBytes);
  resetToolchainDiscoveryRuntimeForTests();

  startInitialToolchainDiscovery();
  const failed = getToolchainDiscoverySnapshot();
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.equal(failed.errorCode, "DISCOVERY_STATE_INVALID");
  }
  assert.equal(fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"), storedBytes);
});

test("a snapshot without a registry revision fails closed", (t) => {
  useDiscoveryFixture(t);
  const missingRevisionSnapshot = {
    schemaVersion: 1,
    status: "complete",
    completedAt: "2026-01-01T00:00:00.000Z",
    profiles: Object.fromEntries(
      listRegisteredLanguageProfiles().map((entry) => [entry.profile.ref.id, []]),
    ),
  };
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  const storedBytes = `${JSON.stringify(missingRevisionSnapshot, null, 2)}\n`;
  fs.writeFileSync(getToolchainDiscoveryFilePath(), storedBytes);
  resetToolchainDiscoveryRuntimeForTests();

  startInitialToolchainDiscovery();
  const failed = getToolchainDiscoverySnapshot();
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.equal(failed.errorCode, "DISCOVERY_STATE_INVALID");
  }
  assert.equal(fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"), storedBytes);
});

test("a malformed candidate in a stale registry snapshot still fails closed", (t) => {
  useDiscoveryFixture(t);
  const malformedSnapshot = {
    schemaVersion: 1,
    registryRevision: 1,
    status: "complete",
    completedAt: "2026-01-01T00:00:00.000Z",
    profiles: {
      [CPP_LANGUAGE_PROFILE_ID]: [{}],
      [PYTHON_LANGUAGE_PROFILE_ID]: [],
    },
  };
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  const storedBytes = `${JSON.stringify(malformedSnapshot, null, 2)}\n`;
  fs.writeFileSync(getToolchainDiscoveryFilePath(), storedBytes);
  resetToolchainDiscoveryRuntimeForTests();

  startInitialToolchainDiscovery();
  const failed = getToolchainDiscoverySnapshot();
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.equal(failed.errorCode, "DISCOVERY_STATE_INVALID");
  }
  assert.equal(fs.readFileSync(getToolchainDiscoveryFilePath(), "utf8"), storedBytes);
});

test("Windows passive discovery checks bounded Eclipse Adoptium JDK roots", {
  skip: os.platform() !== "win32",
}, async (t) => {
  const { root } = useDiscoveryFixture(t);
  const javac = path.join(
    root,
    "Program Files",
    "Eclipse Adoptium",
    "jdk-21.0.12.8-hotspot",
    "bin",
    "javac.exe",
  );
  fs.mkdirSync(path.dirname(javac), { recursive: true });
  createExecutable(javac);

  startInitialToolchainDiscovery();
  const completed = await waitForToolchainDiscovery();
  assert.equal(completed.status, "complete");
  assert.ok(
    completed.profiles[JAVA_LANGUAGE_PROFILE_ID]?.some(
      (candidate) => candidate.canonicalPath === fs.realpathSync(javac),
    ),
  );
});
