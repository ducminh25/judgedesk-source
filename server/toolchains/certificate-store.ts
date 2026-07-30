import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CertifiedHostIdentity,
  CertifiedPathIdentity,
  CertificationProbeResult,
  LanguageProfileId,
  ToolchainCertificate,
  ToolchainCertificateCacheV1,
  ToolchainDeploymentIdentity,
  ToolchainRole,
} from "../languages/contracts.js";
import { isLanguageProfileId } from "../languages/contracts.js";
import { getAppDataDir } from "./storage.js";

const CERTIFICATE_ID_PATTERN = /^cert_[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CERTIFICATES = 128;
const MAX_PATH_IDENTITIES = 256;

export interface ToolchainCertificateStoreSnapshot {
  cache: ToolchainCertificateCacheV1;
  revision: string;
  status: "missing" | "ready" | "recovery";
  diagnostic?: string;
}

export type NewToolchainCertificate = Omit<
  ToolchainCertificate,
  "schemaVersion" | "certificateId"
>;

class CertificateStoreConflictError extends Error {
  constructor() {
    super("Toolchain certificates changed while an update was being committed.");
    this.name = "CertificateStoreConflictError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const unexpected = Object.keys(value).find((key) => !expectedSet.has(key));
  if (unexpected) throw new Error(`${label} contains unknown field '${unexpected}'.`);
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${label} is missing '${missing}'.`);
}

function boundedString(value: unknown, label: string, max = 2048): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function sha256String(value: unknown, label: string): string {
  const result = boundedString(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(result)) throw new Error(`${label} must be a SHA-256 digest.`);
  return result;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  label: string,
  max = 2048,
): string | undefined {
  if (!Object.hasOwn(value, field)) return undefined;
  return boundedString(value[field], label, max);
}

function validatePathIdentity(value: unknown, label: string): CertifiedPathIdentity {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object.`);
  const allowed = [
    "canonicalPath",
    "kind",
    "fileIdentity",
    "sizeBytes",
    "modifiedAt",
    "sha256",
    "treeDigest",
  ];
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains unknown field '${unexpected}'.`);
  if (!Object.hasOwn(value, "canonicalPath") || !Object.hasOwn(value, "kind")) {
    throw new Error(`${label} is incomplete.`);
  }
  const canonicalPath = boundedString(value.canonicalPath, `${label} canonical path`, 32768);
  if (!path.isAbsolute(canonicalPath)) throw new Error(`${label} path must be absolute.`);
  if (value.kind !== "file" && value.kind !== "directory") {
    throw new Error(`${label} has an invalid kind.`);
  }
  const sizeBytes = Object.hasOwn(value, "sizeBytes")
    ? Number(value.sizeBytes)
    : undefined;
  if (
    sizeBytes !== undefined
    && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    throw new Error(`${label} has an invalid size.`);
  }
  const modifiedAt = Object.hasOwn(value, "modifiedAt")
    ? canonicalTimestamp(value.modifiedAt, `${label} modifiedAt`)
    : undefined;
  const sha256 = Object.hasOwn(value, "sha256")
    ? sha256String(value.sha256, `${label} SHA-256`)
    : undefined;
  const treeDigest = Object.hasOwn(value, "treeDigest")
    ? sha256String(value.treeDigest, `${label} tree digest`)
    : undefined;
  if (value.kind === "file" && (!sha256 || sizeBytes === undefined || !modifiedAt)) {
    throw new Error(`${label} file identity is incomplete.`);
  }
  if (value.kind === "directory" && !treeDigest) {
    throw new Error(`${label} directory identity is incomplete.`);
  }
  const fileIdentity = optionalString(value, "fileIdentity", `${label} file identity`, 256);
  return {
    canonicalPath,
    kind: value.kind,
    ...(fileIdentity ? { fileIdentity } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(modifiedAt ? { modifiedAt } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(treeDigest ? { treeDigest } : {}),
  };
}

function validateHost(value: unknown): CertifiedHostIdentity {
  if (!isPlainRecord(value)) throw new Error("Certificate host must be an object.");
  const allowed = ["platform", "architecture", "osVersion", "osBuild"];
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Certificate host contains unknown field '${unexpected}'.`);
  if (value.platform !== "win32" && value.platform !== "darwin") {
    throw new Error("Certificate host platform is invalid.");
  }
  if (value.architecture !== "x64" && value.architecture !== "arm64") {
    throw new Error("Certificate host architecture is invalid.");
  }
  const osBuild = optionalString(value, "osBuild", "Certificate host OS build", 256);
  return {
    platform: value.platform,
    architecture: value.architecture,
    osVersion: boundedString(value.osVersion, "Certificate host OS version", 256),
    ...(osBuild ? { osBuild } : {}),
  };
}

function validateDeployment(value: unknown): ToolchainDeploymentIdentity {
  if (!isPlainRecord(value)) throw new Error("Certificate deployment must be an object.");
  switch (value.kind) {
    case "managed-package":
      assertExactKeys(value, ["kind", "packageId", "packageDigest"], "Managed deployment");
      return {
        kind: value.kind,
        packageId: boundedString(value.packageId, "Managed package ID", 128),
        packageDigest: sha256String(value.packageDigest, "Managed package digest"),
      };
    case "platform-toolchain":
      assertExactKeys(value, ["kind", "platformIdentity"], "Platform deployment");
      return {
        kind: value.kind,
        platformIdentity: sha256String(value.platformIdentity, "Platform identity"),
      };
    case "local-snapshot":
      assertExactKeys(value, ["kind", "snapshotDigest"], "Snapshot deployment");
      return {
        kind: value.kind,
        snapshotDigest: sha256String(value.snapshotDigest, "Snapshot digest"),
      };
    case "certified-local-root":
      assertExactKeys(value, ["kind", "installationFingerprint"], "Local-root deployment");
      return {
        kind: value.kind,
        installationFingerprint: sha256String(
          value.installationFingerprint,
          "Installation fingerprint",
        ),
      };
    default:
      throw new Error("Certificate deployment kind is invalid.");
  }
}

function validateProbe(value: unknown, index: number): CertificationProbeResult {
  if (!isPlainRecord(value)) throw new Error(`Certificate probe ${index} must be an object.`);
  assertExactKeys(
    value,
    ["probeId", "result", "evidenceDigest", "completedAt"],
    `Certificate probe ${index}`,
  );
  if (value.result !== "passed") throw new Error(`Certificate probe ${index} did not pass.`);
  return {
    probeId: boundedString(value.probeId, `Certificate probe ${index} ID`, 128),
    result: "passed",
    evidenceDigest: sha256String(
      value.evidenceDigest,
      `Certificate probe ${index} evidence digest`,
    ),
    completedAt: canonicalTimestamp(
      value.completedAt,
      `Certificate probe ${index} completedAt`,
    ),
  };
}

export function validateToolchainCertificate(value: unknown): ToolchainCertificate {
  if (!isPlainRecord(value)) throw new Error("Toolchain certificate must be an object.");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "certificateId",
      "profile",
      "certifiedRoles",
      "candidateFingerprint",
      "host",
      "toolchain",
      "helperExecutables",
      "supportRoots",
      "dependencyClosureDigest",
      "recipeDigest",
      "deployment",
      "executorVersion",
      "sandboxPolicyVersion",
      "probeSuiteVersion",
      "probes",
      "issuedAt",
    ],
    "Toolchain certificate",
  );
  if (value.schemaVersion !== 1) throw new Error("Unsupported toolchain certificate schema.");
  const certificateId = boundedString(value.certificateId, "Certificate ID", 69);
  if (!CERTIFICATE_ID_PATTERN.test(certificateId)) throw new Error("Certificate ID is invalid.");
  if (!isPlainRecord(value.profile)) throw new Error("Certificate profile must be an object.");
  assertExactKeys(value.profile, ["id", "version"], "Certificate profile");
  if (!isLanguageProfileId(value.profile.id)) throw new Error("Certificate profile ID is invalid.");
  if (!Number.isSafeInteger(value.profile.version) || Number(value.profile.version) < 1) {
    throw new Error("Certificate profile version is invalid.");
  }
  if (!Array.isArray(value.certifiedRoles) || value.certifiedRoles.length === 0) {
    throw new Error("Certificate must contain at least one role.");
  }
  const certifiedRoles = value.certifiedRoles.map((role) => {
    if (role !== "submission" && role !== "checker") {
      throw new Error("Certificate role is invalid.");
    }
    return role;
  }) as [ToolchainRole, ...ToolchainRole[]];
  if (new Set(certifiedRoles).size !== certifiedRoles.length) {
    throw new Error("Certificate contains duplicate roles.");
  }
  if (!isPlainRecord(value.toolchain)) throw new Error("Certificate toolchain must be an object.");
  const allowedToolchainKeys = [
    "executable",
    "family",
    "version",
    "build",
    "distributor",
    "target",
  ];
  const unexpectedToolchainKey = Object.keys(value.toolchain)
    .find((key) => !allowedToolchainKeys.includes(key));
  if (unexpectedToolchainKey) {
    throw new Error(`Certificate toolchain contains unknown field '${unexpectedToolchainKey}'.`);
  }
  for (const required of ["executable", "family", "version", "build", "target"]) {
    if (!Object.hasOwn(value.toolchain, required)) {
      throw new Error(`Certificate toolchain is missing '${required}'.`);
    }
  }
  const distributor = optionalString(
    value.toolchain,
    "distributor",
    "Certificate toolchain distributor",
    512,
  );
  const helperExecutables = validatePathIdentityArray(
    value.helperExecutables,
    "Certificate helper executables",
  );
  if (helperExecutables.some((identity) => identity.kind !== "file")) {
    throw new Error("Certificate helper executables must be files.");
  }
  const supportRoots = validatePathIdentityArray(value.supportRoots, "Certificate support roots");
  if (supportRoots.some((identity) => identity.kind !== "directory")) {
    throw new Error("Certificate support roots must be directories.");
  }
  if (!Array.isArray(value.probes) || value.probes.length === 0 || value.probes.length > 64) {
    throw new Error("Certificate probes must be a non-empty bounded array.");
  }
  const probes = value.probes.map(validateProbe) as [
    CertificationProbeResult,
    ...CertificationProbeResult[],
  ];
  if (new Set(probes.map((probe) => probe.probeId)).size !== probes.length) {
    throw new Error("Certificate contains duplicate probe IDs.");
  }
  return {
    schemaVersion: 1,
    certificateId,
    profile: {
      id: value.profile.id,
      version: Number(value.profile.version),
    },
    certifiedRoles,
    candidateFingerprint: sha256String(
      value.candidateFingerprint,
      "Candidate fingerprint",
    ),
    host: validateHost(value.host),
    toolchain: {
      executable: validatePathIdentity(
        value.toolchain.executable,
        "Certificate executable",
      ),
      family: boundedString(value.toolchain.family, "Certificate toolchain family", 128),
      version: boundedString(value.toolchain.version, "Certificate toolchain version", 128),
      build: boundedString(value.toolchain.build, "Certificate toolchain build", 512),
      ...(distributor ? { distributor } : {}),
      target: boundedString(value.toolchain.target, "Certificate toolchain target", 256),
    },
    helperExecutables,
    supportRoots,
    dependencyClosureDigest: sha256String(
      value.dependencyClosureDigest,
      "Dependency closure digest",
    ),
    recipeDigest: sha256String(value.recipeDigest, "Recipe digest"),
    deployment: validateDeployment(value.deployment),
    executorVersion: boundedString(value.executorVersion, "Executor version", 128),
    sandboxPolicyVersion: boundedString(
      value.sandboxPolicyVersion,
      "Sandbox policy version",
      128,
    ),
    probeSuiteVersion: boundedString(value.probeSuiteVersion, "Probe suite version", 128),
    probes,
    issuedAt: canonicalTimestamp(value.issuedAt, "Certificate issuedAt"),
  };
}

function validatePathIdentityArray(value: unknown, label: string): CertifiedPathIdentity[] {
  if (!Array.isArray(value) || value.length > MAX_PATH_IDENTITIES) {
    throw new Error(`${label} must be a bounded array.`);
  }
  return value.map((identity, index) => validatePathIdentity(identity, `${label}[${index}]`));
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Certificate JSON contains an unsafe number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!isPlainRecord(value)) throw new Error("Certificate JSON contains an unsupported value.");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  ).join(",")}}`;
}

function contentRevision(bytes: Uint8Array | null): string {
  if (bytes === null) return "missing";
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readBytes(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(directory: string): void {
  if (os.platform() === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function getToolchainCertificatesFilePath(): string {
  const directory = getAppDataDir();
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "toolchain-certificates.json");
}

function emptyCache(): ToolchainCertificateCacheV1 {
  return { schemaVersion: 1, certificates: {} };
}

function decodeCache(value: unknown): ToolchainCertificateCacheV1 {
  if (!isPlainRecord(value)) throw new Error("Certificate cache must be an object.");
  assertExactKeys(value, ["schemaVersion", "certificates"], "Certificate cache");
  if (value.schemaVersion !== 1) throw new Error("Unsupported certificate cache schema.");
  if (!isPlainRecord(value.certificates)) throw new Error("Certificate cache entries are invalid.");
  const entries = Object.entries(value.certificates);
  if (entries.length > MAX_CERTIFICATES) throw new Error("Certificate cache contains too many entries.");
  const certificates: Record<string, ToolchainCertificate> = {};
  for (const [certificateId, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const certificate = validateToolchainCertificate(raw);
    if (certificate.certificateId !== certificateId) {
      throw new Error(`Certificate cache key '${certificateId}' does not match its certificate ID.`);
    }
    certificates[certificateId] = certificate;
  }
  return { schemaVersion: 1, certificates };
}

export function loadToolchainCertificateStore(): ToolchainCertificateStoreSnapshot {
  const bytes = readBytes(getToolchainCertificatesFilePath());
  if (bytes === null) {
    return { cache: emptyCache(), revision: "missing", status: "missing" };
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return {
      cache: decodeCache(value),
      revision: contentRevision(bytes),
      status: "ready",
    };
  } catch (error) {
    return {
      cache: emptyCache(),
      revision: contentRevision(bytes),
      status: "recovery",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeCache(
  cache: ToolchainCertificateCacheV1,
  expectedRevision: string,
): string {
  const validated = decodeCache(cache);
  const contents = `${canonicalize(validated)}\n`;
  const filePath = getToolchainCertificatesFilePath();
  const directory = path.dirname(filePath);
  if (contentRevision(readBytes(filePath)) !== expectedRevision) {
    throw new CertificateStoreConflictError();
  }
  const temporaryPath = path.join(
    directory,
    `.toolchain-certificates.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (contentRevision(readBytes(filePath)) !== expectedRevision) {
      throw new CertificateStoreConflictError();
    }
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(directory);
    return contentRevision(Buffer.from(contents, "utf8"));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function createToolchainCertificate(
  value: NewToolchainCertificate,
): ToolchainCertificate {
  const idPayload = canonicalize({ schemaVersion: 1, ...value });
  const certificateId = `cert_${crypto.createHash("sha256").update(idPayload).digest("hex")}`;
  return validateToolchainCertificate({
    schemaVersion: 1,
    certificateId,
    ...value,
  });
}

export function saveToolchainCertificate(
  certificate: ToolchainCertificate,
): ToolchainCertificateStoreSnapshot {
  const validated = validateToolchainCertificate(certificate);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = loadToolchainCertificateStore();
    if (snapshot.status === "recovery") {
      throw new Error("Toolchain certificate cache requires recovery before it can be modified.");
    }
    const cache: ToolchainCertificateCacheV1 = {
      schemaVersion: 1,
      certificates: {
        ...snapshot.cache.certificates,
        [validated.certificateId]: validated,
      },
    };
    try {
      return {
        cache,
        revision: writeCache(cache, snapshot.revision),
        status: "ready",
      };
    } catch (error) {
      if (!(error instanceof CertificateStoreConflictError) || attempt === 2) throw error;
    }
  }
  throw new CertificateStoreConflictError();
}

export function findToolchainCertificate(
  profileId: LanguageProfileId,
  profileVersion: number,
  candidateFingerprint: string,
  requiredRole: ToolchainRole,
): ToolchainCertificate | undefined {
  const snapshot = loadToolchainCertificateStore();
  if (snapshot.status === "recovery") return undefined;
  return Object.values(snapshot.cache.certificates)
    .filter((certificate): certificate is ToolchainCertificate => !!certificate)
    .filter((certificate) =>
      certificate.profile.id === profileId
      && certificate.profile.version === profileVersion
      && certificate.candidateFingerprint === candidateFingerprint
      && certificate.certifiedRoles.includes(requiredRole)
    )
    .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))[0];
}
