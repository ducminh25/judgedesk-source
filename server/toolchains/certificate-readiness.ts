import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CertifiedPathIdentity,
  ReadinessReasonCode,
  ToolchainCertificate,
} from "../languages/contracts.js";
import { CPP_LANGUAGE_PROFILE_ID } from "../languages/registry.js";
import { executorClient } from "../executor/client.js";
import type { ExecutorHealth } from "../executor/protocol.js";
import { loadToolchainCertificateStore } from "./certificate-store.js";
import {
  getLocalCppCertificationRecipeDigest,
  LOCAL_CPP_PROBE_SUITE_VERSION,
} from "./cpp-certification-policy.js";
import { findLocalToolchainSnapshot } from "./snapshot.js";

const MiB = 1024 * 1024;
const REQUIRED_CPP_PROBES = new Set([
  "snapshot-integrity",
  "compiler-identity",
  "executor-security-boundary",
  "cpp-submission-compile-run",
  "cpp-checker-compile-run",
]);

export type LocalCppCertificateReadiness =
  | {
      state: "ready";
      certificate: ToolchainCertificate;
      canonicalExecutablePath: string;
      snapshotExecutablePath: string;
      snapshotExecutableId: string;
      snapshotRoot: string;
    }
  | {
      state: "not_ready";
      code: ReadinessReasonCode;
      diagnostic: string;
      certificateId?: string;
    };

export interface LocalCppCertificateReadinessOptions {
  platform?: NodeJS.Platform;
  architecture?: "x64" | "arm64";
  osVersion?: string;
  osBuild?: string;
  executorHealth?: ExecutorHealth;
  executorRoot?: string;
  certificates?: readonly ToolchainCertificate[];
  certificateStoreStatus?: "missing" | "ready" | "recovery";
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function descendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function readCertifiedFileIdentitySync(filePath: string): CertifiedPathIdentity {
  const requested = fs.lstatSync(filePath);
  if (!requested.isFile() || requested.isSymbolicLink()) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: candidate is not a regular non-link file.");
  }
  const canonicalPath = fs.realpathSync(filePath);
  const before = fs.statSync(canonicalPath, { bigint: true });
  if (!before.isFile()) throw new Error("LOCAL_EXECUTABLE_INVALID: candidate is not a regular file.");
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(canonicalPath, "r");
  const buffer = Buffer.allocUnsafe(MiB);
  try {
    let offset = 0;
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.statSync(canonicalPath, { bigint: true });
  if (
    before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.dev !== after.dev
    || before.ino !== after.ino
  ) {
    throw new Error("TOOLCHAIN_DRIFTED: compiler changed while it was revalidated.");
  }
  return {
    canonicalPath,
    kind: "file",
    fileIdentity: `${after.dev.toString(16)}:${after.ino.toString(16)}`,
    sizeBytes: Number(after.size),
    modifiedAt: new Date(Number(after.mtimeNs / 1_000_000n)).toISOString(),
    sha256: digest.digest("hex"),
  };
}

function fileIdentityMatches(
  certified: CertifiedPathIdentity,
  current: CertifiedPathIdentity,
  platform: NodeJS.Platform,
): boolean {
  return certified.kind === "file"
    && samePath(certified.canonicalPath, current.canonicalPath, platform)
    && certified.fileIdentity === current.fileIdentity
    && certified.sizeBytes === current.sizeBytes
    && certified.modifiedAt === current.modifiedAt
    && certified.sha256 === current.sha256;
}

function failure(
  code: ReadinessReasonCode,
  diagnostic: string,
  certificateId?: string,
): LocalCppCertificateReadiness {
  return {
    state: "not_ready",
    code,
    diagnostic,
    ...(certificateId ? { certificateId } : {}),
  };
}

function currentArchitecture(): "x64" | "arm64" {
  return os.arch() === "arm64" ? "arm64" : "x64";
}

export function resolveLocalCppCertificateReadiness(
  executablePath: string,
  options: LocalCppCertificateReadinessOptions = {},
): LocalCppCertificateReadiness {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return failure(
      "CERTIFICATION_REQUIRED",
      "Local snapshot certificates are currently enabled for Windows GNU C++ only.",
    );
  }

  let canonicalExecutablePath: string;
  try {
    const metadata = fs.lstatSync(executablePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular file");
    canonicalExecutablePath = fs.realpathSync(executablePath);
  } catch {
    return failure("LOCAL_PATH_MISSING", "The selected local compiler is missing or is not a regular file.");
  }

  const store = options.certificates
    ? {
        status: options.certificateStoreStatus ?? "ready" as const,
        certificates: options.certificates,
      }
    : (() => {
        const snapshot = loadToolchainCertificateStore();
        return {
          status: snapshot.status,
          certificates: Object.values(snapshot.cache.certificates)
            .filter((certificate): certificate is ToolchainCertificate => !!certificate),
        };
      })();
  if (store.status === "recovery") {
    return failure("CERTIFICATE_STALE", "The toolchain certificate cache requires recovery.");
  }
  const certificates = store.certificates
    .filter((certificate) =>
      certificate.profile.id === CPP_LANGUAGE_PROFILE_ID
      && certificate.profile.version === 1
      && samePath(
        certificate.toolchain.executable.canonicalPath,
        canonicalExecutablePath,
        platform,
      )
    )
    .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
  if (certificates.length === 0) {
    return failure(
      "CERTIFICATION_REQUIRED",
      "The selected local C++ compiler must be certified before judging.",
    );
  }

  const architecture = options.architecture ?? currentArchitecture();
  const osVersion = options.osVersion ?? os.release();
  const osBuild = options.osBuild ?? os.version();
  const health = options.executorHealth ?? executorClient.health;
  let newestFailure: LocalCppCertificateReadiness | undefined;
  for (const certificate of certificates) {
    const stale = (code: ReadinessReasonCode, diagnostic: string) => {
      newestFailure ||= failure(code, diagnostic, certificate.certificateId);
    };
    if (
      certificate.host.platform !== "win32"
      || certificate.host.architecture !== architecture
      || certificate.host.osVersion !== osVersion
      || certificate.host.osBuild !== osBuild
    ) {
      stale("CERTIFICATE_STALE", "The certificate belongs to a different Windows host build.");
      continue;
    }
    if (
      certificate.recipeDigest !== getLocalCppCertificationRecipeDigest()
      || certificate.probeSuiteVersion !== LOCAL_CPP_PROBE_SUITE_VERSION
    ) {
      stale("CERTIFICATE_STALE", "The compiler policy or certification probe suite has changed.");
      continue;
    }
    if (
      !certificate.certifiedRoles.includes("submission")
      || !certificate.certifiedRoles.includes("checker")
      || [...REQUIRED_CPP_PROBES].some(
        (probeId) => !certificate.probes.some((probe) => probe.probeId === probeId),
      )
    ) {
      stale("CERTIFICATE_STALE", "The certificate does not cover both submission and checker roles.");
      continue;
    }
    if (!health.ready) {
      stale(
        "LOCAL_NOT_SANDBOX_COMPATIBLE",
        health.diagnostics.join("; ") || "The native secure executor is unavailable.",
      );
      continue;
    }
    if (
      health.mode !== "windows-lpac-job"
      || health.executorVersion !== certificate.executorVersion
      || `${health.mode}.v1` !== certificate.sandboxPolicyVersion
      || !health.networkBlocked
      || !health.filesystemIsolated
      || !health.processTreeControlled
    ) {
      stale("CERTIFICATE_STALE", "The native executor or its security policy has changed.");
      continue;
    }

    let currentExecutable: CertifiedPathIdentity;
    try {
      currentExecutable = readCertifiedFileIdentitySync(canonicalExecutablePath);
    } catch (error) {
      stale("TOOLCHAIN_DRIFTED", error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!fileIdentityMatches(certificate.toolchain.executable, currentExecutable, platform)) {
      stale("TOOLCHAIN_DRIFTED", "The selected local compiler changed after certification.");
      continue;
    }
    if (
      certificate.deployment.kind !== "local-snapshot"
      || certificate.dependencyClosureDigest !== certificate.deployment.snapshotDigest
    ) {
      stale("CERTIFICATE_STALE", "The certificate does not reference an immutable local snapshot.");
      continue;
    }
    const snapshotDigest = certificate.deployment.snapshotDigest;
    const supportRoot = certificate.supportRoots.find((root) =>
      root.kind === "directory"
      && root.treeDigest === snapshotDigest
      && descendant(root.canonicalPath, canonicalExecutablePath)
    );
    if (!supportRoot) {
      stale("CERTIFICATE_STALE", "The certified dependency root no longer matches the selected compiler.");
      continue;
    }
    const relativeExecutablePath = path.relative(
      supportRoot.canonicalPath,
      canonicalExecutablePath,
    ).replaceAll("\\", "/");
    const snapshot = findLocalToolchainSnapshot({
      kind: "cpp",
      snapshotDigest,
      relativeExecutablePath,
      executorRoot: options.executorRoot || health.executorRoot,
    });
    if (!snapshot) {
      stale("CERTIFICATE_STALE", "The certified local toolchain snapshot is missing or invalid.");
      continue;
    }
    let snapshotExecutable: CertifiedPathIdentity;
    try {
      snapshotExecutable = readCertifiedFileIdentitySync(snapshot.executablePath);
    } catch (error) {
      stale("TOOLCHAIN_DRIFTED", error instanceof Error ? error.message : String(error));
      continue;
    }
    if (
      snapshotExecutable.sha256 !== certificate.toolchain.executable.sha256
      || snapshotExecutable.sizeBytes !== certificate.toolchain.executable.sizeBytes
    ) {
      stale("TOOLCHAIN_DRIFTED", "The certified snapshot compiler changed after certification.");
      continue;
    }
    return {
      state: "ready",
      certificate,
      canonicalExecutablePath,
      snapshotExecutablePath: snapshot.executablePath,
      snapshotExecutableId: snapshot.executableId,
      snapshotRoot: snapshot.root,
    };
  }
  return newestFailure || failure(
    "CERTIFICATE_STALE",
    "No current certificate matches the selected local C++ compiler.",
  );
}
