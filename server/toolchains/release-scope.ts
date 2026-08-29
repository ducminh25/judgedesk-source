import type {
  HostArchitecture,
  HostPlatform,
} from "../languages/contracts.js";
import type { ToolchainKind } from "./types.js";

/**
 * Languages committed for the current public release. Other implemented
 * adapters remain dormant until their own release gate is approved.
 */
export const CURRENT_RELEASE_TOOLCHAIN_KINDS = Object.freeze([
  "cpp",
  "c",
  "python",
  "pascal",
  "java",
  "scratch",
] as const satisfies readonly ToolchainKind[]);

const CURRENT_RELEASE_TOOLCHAIN_KIND_SET: ReadonlySet<ToolchainKind> =
  new Set(CURRENT_RELEASE_TOOLCHAIN_KINDS);

/**
 * C and C++ share GCC on Windows. On macOS they use the platform-certified
 * Apple Clang toolchain, so no managed C/C++ package is distributed.
 */
const CURRENT_RELEASE_MANAGED_PACKAGES = Object.freeze({
  "win32:x64": Object.freeze([
    "gcc-windows-x64",
    "python-windows-x64",
    "fpc-windows-x64",
    "temurin21-windows-x64",
    "scratch-windows-x64",
  ]),
  "darwin:arm64": Object.freeze([
    "python-macos-arm64",
    "fpc-macos-arm64",
    "temurin21-macos-arm64",
    "scratch-macos-arm64",
  ]),
} as const);

export function isCurrentReleaseToolchainKind(
  kind: ToolchainKind,
): boolean {
  return CURRENT_RELEASE_TOOLCHAIN_KIND_SET.has(kind);
}

export function listCurrentReleaseManagedPackageIds(
  platform: HostPlatform,
  arch: HostArchitecture,
): readonly string[] {
  const key = `${platform}:${arch}` as keyof typeof CURRENT_RELEASE_MANAGED_PACKAGES;
  return CURRENT_RELEASE_MANAGED_PACKAGES[key] ?? [];
}

export function isCurrentReleaseManagedPackageId(
  packageId: string,
  platform: HostPlatform,
  arch: HostArchitecture,
): boolean {
  return listCurrentReleaseManagedPackageIds(platform, arch).includes(packageId);
}
