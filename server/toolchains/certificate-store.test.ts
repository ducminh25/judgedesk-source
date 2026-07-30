import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { NewToolchainCertificate } from "./certificate-store.js";
import {
  createToolchainCertificate,
  findToolchainCertificate,
  getToolchainCertificatesFilePath,
  loadToolchainCertificateStore,
  saveToolchainCertificate,
} from "./certificate-store.js";
import { CPP_LANGUAGE_PROFILE_ID } from "../languages/registry.js";

function useTemporaryAppData(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-cert-store-"));
  const previous = process.env.THEMIS_APP_DATA_DIR;
  process.env.THEMIS_APP_DATA_DIR = directory;
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previous;
  });
  return directory;
}

function certificateFixture(overrides: Partial<NewToolchainCertificate> = {}): NewToolchainCertificate {
  const now = "2026-07-30T00:00:00.000Z";
  const executablePath = path.resolve("C:/toolchains/gcc/bin/g++.exe");
  const rootPath = path.resolve("C:/toolchains/gcc");
  return {
    profile: { id: CPP_LANGUAGE_PROFILE_ID, version: 1 },
    certifiedRoles: ["submission", "checker"],
    candidateFingerprint: "1".repeat(64),
    host: {
      platform: "win32",
      architecture: "x64",
      osVersion: "10.0.26100",
      osBuild: "26100",
    },
    toolchain: {
      executable: {
        canonicalPath: executablePath,
        kind: "file",
        fileIdentity: "volume:1:file:2",
        sizeBytes: 1024,
        modifiedAt: now,
        sha256: "2".repeat(64),
      },
      family: "gcc",
      distributor: "MSYS2 project",
      version: "16.1.0",
      build: "Rev5",
      target: "x86_64-w64-mingw32",
    },
    helperExecutables: [],
    supportRoots: [{
      canonicalPath: rootPath,
      kind: "directory",
      treeDigest: "3".repeat(64),
    }],
    dependencyClosureDigest: "3".repeat(64),
    recipeDigest: "4".repeat(64),
    deployment: { kind: "local-snapshot", snapshotDigest: "3".repeat(64) },
    executorVersion: "1.2.7",
    sandboxPolicyVersion: "windows-lpac-job-v1",
    probeSuiteVersion: "legacy.cpp.probes.v1",
    probes: [{
      probeId: "compile-run",
      result: "passed",
      evidenceDigest: "5".repeat(64),
      completedAt: now,
    }],
    issuedAt: now,
    ...overrides,
  };
}

test("certificate store creates deterministic IDs and persists canonical records", (t) => {
  useTemporaryAppData(t);
  const certificate = createToolchainCertificate(certificateFixture());
  assert.match(certificate.certificateId, /^cert_[a-f0-9]{64}$/);
  assert.equal(
    createToolchainCertificate(certificateFixture()).certificateId,
    certificate.certificateId,
  );
  const stored = saveToolchainCertificate(certificate);
  assert.equal(stored.status, "ready");
  assert.equal(stored.cache.certificates[certificate.certificateId]?.certificateId, certificate.certificateId);
  assert.equal(
    findToolchainCertificate(CPP_LANGUAGE_PROFILE_ID, 1, "1".repeat(64), "submission")
      ?.certificateId,
    certificate.certificateId,
  );
  assert.equal(
    findToolchainCertificate(CPP_LANGUAGE_PROFILE_ID, 1, "1".repeat(64), "checker")
      ?.certificateId,
    certificate.certificateId,
  );
  const text = fs.readFileSync(getToolchainCertificatesFilePath(), "utf8");
  assert.equal(text.endsWith("\n"), true);
  assert.equal(loadToolchainCertificateStore().revision.length, 64);
});

test("certificate store fails closed on corruption and never overwrites it", (t) => {
  useTemporaryAppData(t);
  const filePath = getToolchainCertificatesFilePath();
  fs.writeFileSync(filePath, '{"schemaVersion":2,"certificates":{}}\n', "utf8");
  const before = fs.readFileSync(filePath, "utf8");
  const snapshot = loadToolchainCertificateStore();
  assert.equal(snapshot.status, "recovery");
  assert.match(snapshot.diagnostic || "", /Unsupported certificate cache schema/);
  assert.throws(
    () => saveToolchainCertificate(createToolchainCertificate(certificateFixture())),
    /requires recovery/,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
});

test("certificate store rejects mismatched keys, incomplete files, and unknown fields", (t) => {
  useTemporaryAppData(t);
  const certificate = createToolchainCertificate(certificateFixture());
  const raw = JSON.parse(JSON.stringify({
    schemaVersion: 1,
    certificates: { wrong: certificate },
  }));
  fs.writeFileSync(getToolchainCertificatesFilePath(), JSON.stringify(raw), "utf8");
  assert.equal(loadToolchainCertificateStore().status, "recovery");

  fs.rmSync(getToolchainCertificatesFilePath(), { force: true });
  const incomplete = certificateFixture();
  incomplete.toolchain = {
    ...incomplete.toolchain,
    executable: {
      canonicalPath: incomplete.toolchain.executable.canonicalPath,
      kind: "file",
    },
  };
  assert.throws(() => createToolchainCertificate(incomplete), /file identity is incomplete/);

  const withUnknown = certificateFixture() as NewToolchainCertificate & { injected?: boolean };
  withUnknown.injected = true;
  assert.throws(() => createToolchainCertificate(withUnknown), /unknown field 'injected'/);
});
