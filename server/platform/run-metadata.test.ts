import assert from "node:assert/strict";
import test from "node:test";
import { createRunMetadata } from "./run-metadata.js";

test("run metadata records the exact certified local C++ batch pin", () => {
  const certificateId = `cert_${"a".repeat(64)}`;
  const fingerprint = "b".repeat(64);
  const snapshotDigest = "c".repeat(64);
  const metadata = createRunMetadata({
    cpp: {
      kind: "cpp",
      source: "custom",
      executablePath: String.raw`C:\msys64\ucrt64\bin\g++.exe`,
      executionPath: String.raw`C:\executor\toolchains\local_cpp\payload\bin\g++.exe`,
      executionId: "toolchains/local_cpp/payload/bin/g++.exe",
      executionRoot: String.raw`C:\executor\toolchains\local_cpp`,
      version: "16.1.0",
      ready: true,
      provenance: "certified-local",
      certificateId,
      candidateFingerprint: fingerprint,
      snapshotDigest,
      certifiedRoles: ["submission", "checker"],
    },
    python: {
      kind: "python",
      source: "managed",
      executablePath: String.raw`C:\managed\python.exe`,
      version: "3.12.13",
      ready: true,
    },
  });
  assert.equal(metadata.toolchains.cpp.submissionReady, true);
  assert.equal(metadata.toolchains.cpp.checkerReady, true);
  assert.equal(metadata.toolchains.cpp.provenance, "certified-local");
  assert.equal(metadata.toolchains.cpp.certificateId, certificateId);
  assert.equal(metadata.toolchains.cpp.candidateFingerprint, fingerprint);
  assert.equal(metadata.toolchains.cpp.snapshotDigest, snapshotDigest);
});
