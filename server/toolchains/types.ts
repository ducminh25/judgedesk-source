export type ToolchainKind = "cpp" | "python";
import type {
  ReadinessReasonCode,
  ToolchainProvenance,
  ToolchainRole,
} from "../languages/contracts.js";

export type ToolchainSource =
  | "none"
  | "managed"
  | "custom"
  | "system"
  | "sandbox";

export interface ToolchainCatalogEntry {
  id: string;
  kind: ToolchainKind;
  version: string;
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
  archiveFormat: "zip" | "tar.gz" | "tar.zst";
  executableRelativePath: string;
  licenseFiles: string[];
}

export interface ToolchainDescriptor extends ToolchainCatalogEntry {
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  manifestSchemaVersion?: 1 | 2;
  minimumOs?: string;
  installedSizeBytes?: number;
  entrypointComponentId?: string;
  components?: readonly ToolchainPackageComponent[];
  healthProbeId?: string;
  upstreamUrl?: string;
  license?: ToolchainPackageLicense;
  signingKeyId?: string;
}

export type ToolchainPackageRole =
  | "compiler"
  | "submission-runtime"
  | "checker-runtime";

export type ToolchainPackageComponentKind =
  | "executable"
  | "support-root";

export interface ToolchainPackageComponent {
  id: string;
  kind: ToolchainPackageComponentKind;
  relativePath: string;
  roles: readonly ToolchainPackageRole[];
}

export interface ToolchainPackageLicense {
  spdxExpression: string;
  licenseFiles: readonly string[];
  noticeFiles: readonly string[];
  sbomPath: string;
}

export interface ToolchainManifestV1Document {
  schemaVersion: 1;
  generatedAt: string;
  toolchains: ToolchainDescriptor[];
}

export interface ToolchainManifestV2Package {
  id: string;
  kind: ToolchainKind;
  version: string;
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
  minimumOs: string;
  archiveFormat: "zip" | "tar.gz" | "tar.zst";
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  installedSizeBytes: number;
  entrypointComponentId: string;
  components: readonly ToolchainPackageComponent[];
  healthProbeId: string;
  upstreamUrl: string;
  license: ToolchainPackageLicense;
}

export interface ToolchainManifestV2Payload {
  generatedAt: string;
  packages: readonly ToolchainManifestV2Package[];
}

export interface ToolchainManifestV2Document {
  schemaVersion: 2;
  signed: ToolchainManifestV2Payload;
  signature: {
    algorithm: "ed25519";
    keyId: string;
    value: string;
  };
}

export type ToolchainManifestDocument =
  | ToolchainManifestV1Document
  | ToolchainManifestV2Document;

export interface ResolvedToolchain {
  kind: ToolchainKind;
  source: ToolchainSource;
  executablePath: string;
  version: string;
  ready: boolean;
  diagnostic?: string;
  diagnosticCode?: ReadinessReasonCode;
  candidateId?: string;
  provenance?: ToolchainProvenance;
  certificateId?: string;
  candidateFingerprint?: string;
  certificateIssuedAt?: string;
  certifiedRoles?: readonly ToolchainRole[];
  snapshotDigest?: string;
  /** Trusted executor-cache path; executablePath remains the user-selected source path. */
  executionPath?: string;
  executionId?: string;
  executionRoot?: string;
}

export interface InstallProgress {
  id: string;
  status:
    "idle" | "downloading" | "extracting" | "verifying" | "success" | "failed";
  percent: number;
  bytesReceived: number;
  totalBytes: number;
  error?: string;
}
