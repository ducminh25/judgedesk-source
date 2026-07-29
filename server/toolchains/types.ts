export type ToolchainKind = "cpp" | "python";
import type { ReadinessReasonCode } from "../languages/contracts.js";

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
}

export interface ToolchainManifestDocument {
  schemaVersion: 1;
  generatedAt: string;
  toolchains: ToolchainDescriptor[];
}

export interface ResolvedToolchain {
  kind: ToolchainKind;
  source: ToolchainSource;
  executablePath: string;
  version: string;
  ready: boolean;
  diagnostic?: string;
  diagnosticCode?: ReadinessReasonCode;
  candidateId?: string;
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
