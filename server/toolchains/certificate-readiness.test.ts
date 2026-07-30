import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolchainCertificate } from "./certificate-store.js";
import { CPP_LANGUAGE_PROFILE_ID } from "../languages/registry.js";
import {
  readCertifiedFileIdentitySync,
  resolveLocalCppCertificateReadiness,
} from "./certificate-readiness.js";
import {
  getLocalCppCertificationRecipeDigest,
  LOCAL_CPP_PROBE_SUITE_VERSION,
} from "./cpp-certification-policy.js";
import { createLocalToolchainSnapshot } from "./snapshot.js";

const health = {
  ready: true,
  mode: "windows-lpac-job" as const,
  executorVersion: "test-executor-v1",
  executorRoot: "",
  diagnostics: [],
  networkBlocked: true,
  filesystemIsolated: true,
  processTreeControlled: true,
  memoryLimitSupported: true,
};

test("a local C++ certificate resolves only to its immutable executor snapshot", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-certificate-ready-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "ucrt64");
  const executablePath = path.join(sourceRoot, "bin", "g++.exe");
  const executorRoot = path.join(temporary, "executor");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(executorRoot, { recursive: true });
  fs.writeFileSync(executablePath, "fake-gcc-v1");
  const snapshot = await createLocalToolchainSnapshot({
    kind: "cpp",
    sourceRoot,
    executablePath,
    executorRoot,
  });
  const issuedAt = new Date().toISOString();
  const certificate = createToolchainCertificate({
    profile: { id: CPP_LANGUAGE_PROFILE_ID, version: 1 },
    certifiedRoles: ["submission", "checker"],
    candidateFingerprint: "1".repeat(64),
    host: {
      platform: "win32",
      architecture: "x64",
      osVersion: "test-os-release",
      osBuild: "test-os-build",
    },
    toolchain: {
      executable: readCertifiedFileIdentitySync(executablePath),
      family: "gcc",
      version: "16.1.0",
      build: "g++ (MSYS2) 16.1.0",
      distributor: "MSYS2 project",
      target: "x86_64-w64-mingw32",
    },
    helperExecutables: [],
    supportRoots: [{
      canonicalPath: fs.realpathSync(sourceRoot),
      kind: "directory",
      sizeBytes: snapshot.totalBytes,
      treeDigest: snapshot.treeDigest,
    }],
    dependencyClosureDigest: snapshot.treeDigest,
    recipeDigest: getLocalCppCertificationRecipeDigest(),
    deployment: { kind: "local-snapshot", snapshotDigest: snapshot.treeDigest },
    executorVersion: health.executorVersion,
    sandboxPolicyVersion: `${health.mode}.v1`,
    probeSuiteVersion: LOCAL_CPP_PROBE_SUITE_VERSION,
    probes: [
      "snapshot-integrity",
      "compiler-identity",
      "executor-security-boundary",
      "cpp-submission-compile-run",
      "cpp-checker-compile-run",
    ].map((probeId) => ({
      probeId,
      result: "passed" as const,
      evidenceDigest: "2".repeat(64),
      completedAt: issuedAt,
    })) as [
      { probeId: string; result: "passed"; evidenceDigest: string; completedAt: string },
      ...Array<{ probeId: string; result: "passed"; evidenceDigest: string; completedAt: string }>,
    ],
    issuedAt,
  });

  const ready = resolveLocalCppCertificateReadiness(executablePath, {
    platform: "win32",
    architecture: "x64",
    osVersion: "test-os-release",
    osBuild: "test-os-build",
    executorHealth: { ...health, executorRoot },
    executorRoot,
    certificates: [certificate],
  });
  assert.equal(ready.state, "ready");
  if (ready.state === "ready") {
    assert.equal(ready.certificate.certificateId, certificate.certificateId);
    assert.equal(ready.snapshotExecutablePath, snapshot.executablePath);
    assert.notEqual(ready.snapshotExecutablePath, fs.realpathSync(executablePath));
  }

  const unavailableExecutor = resolveLocalCppCertificateReadiness(executablePath, {
    platform: "win32",
    architecture: "x64",
    osVersion: "test-os-release",
    osBuild: "test-os-build",
    executorHealth: {
      ...health,
      ready: false,
      mode: "unavailable",
      executorRoot,
      diagnostics: ["secure runner startup failed"],
    },
    executorRoot,
    certificates: [certificate],
  });
  assert.equal(unavailableExecutor.state, "not_ready");
  if (unavailableExecutor.state === "not_ready") {
    assert.equal(unavailableExecutor.code, "LOCAL_NOT_SANDBOX_COMPATIBLE");
  }

  fs.writeFileSync(snapshot.executablePath, "tampered-snapshot");
  const tamperedSnapshot = resolveLocalCppCertificateReadiness(executablePath, {
    platform: "win32",
    architecture: "x64",
    osVersion: "test-os-release",
    osBuild: "test-os-build",
    executorHealth: { ...health, executorRoot },
    executorRoot,
    certificates: [certificate],
  });
  assert.equal(tamperedSnapshot.state, "not_ready");
  if (tamperedSnapshot.state === "not_ready") {
    assert.equal(tamperedSnapshot.code, "TOOLCHAIN_DRIFTED");
  }
  fs.writeFileSync(snapshot.executablePath, "fake-gcc-v1");

  fs.writeFileSync(executablePath, "fake-gcc-v2");
  const drifted = resolveLocalCppCertificateReadiness(executablePath, {
    platform: "win32",
    architecture: "x64",
    osVersion: "test-os-release",
    osBuild: "test-os-build",
    executorHealth: { ...health, executorRoot },
    executorRoot,
    certificates: [certificate],
  });
  assert.equal(drifted.state, "not_ready");
  if (drifted.state === "not_ready") assert.equal(drifted.code, "TOOLCHAIN_DRIFTED");
});

test("an uncertified local C++ compiler remains structurally selectable but not ready", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-certificate-missing-"));
  try {
    const executablePath = path.join(temporary, "bin", "g++.exe");
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "fake-gcc");
    const result = resolveLocalCppCertificateReadiness(executablePath, {
      platform: "win32",
      architecture: "x64",
      osVersion: "test-os-release",
      osBuild: "test-os-build",
      certificates: [],
    });
    assert.equal(result.state, "not_ready");
    if (result.state === "not_ready") assert.equal(result.code, "CERTIFICATION_REQUIRED");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
