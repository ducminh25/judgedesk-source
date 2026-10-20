export type UpdateEdition = "core" | "full";
export type LinuxUpdateBundleType = "deb" | "rpm" | "appimage";

export interface UpdateHostIdentity {
  distribution: UpdateEdition | "development";
  platform: string;
  arch: string;
  bundleType?: LinuxUpdateBundleType;
}

export interface AppUpdateCandidate {
  edition: UpdateEdition;
  version: string;
  target: string;
  downloadSizeBytes: number;
  installedSizeBytes: number;
}

export interface UpdaterMetadataSource {
  version: string;
  rawJson: unknown;
}

export interface ClosableUpdateResource {
  close(): Promise<void>;
}

export function updaterTargetForHost(
  host: Pick<UpdateHostIdentity, "platform" | "arch" | "bundleType">,
  edition: UpdateEdition,
): string {
  if (host.platform === "win32" && host.arch === "x64") {
    return `windows-x86_64-${edition}`;
  }
  if (host.platform === "darwin" && host.arch === "arm64") {
    return `darwin-aarch64-${edition}`;
  }
  if (host.platform === "linux" && host.arch === "x64") {
    if (
      host.bundleType === "deb"
      || host.bundleType === "rpm"
      || host.bundleType === "appimage"
    ) {
      return `linux-x86_64-${host.bundleType}-${edition}`;
    }
    return `linux-x86_64-${edition}`;
  }
  throw new Error(`Unsupported updater host: ${host.platform}/${host.arch}`);
}

export function parseUpdateCandidate(
  update: UpdaterMetadataSource,
  target: string,
  expectedEdition: UpdateEdition,
): AppUpdateCandidate {
  const raw = asRecord(update.rawJson);
  const platforms = asRecord(raw?.platforms);
  const entry = asRecord(platforms?.[target]);
  const metadata = asRecord(entry?.judgedesk);
  const downloadSizeBytes = metadata?.downloadSizeBytes;
  const installedSizeBytes = metadata?.installedSizeBytes;
  if (
    metadata?.edition !== expectedEdition
    || !isPositiveSafeInteger(downloadSizeBytes)
    || !isPositiveSafeInteger(installedSizeBytes)
  ) {
    throw new Error(`Invalid JudgeDesk updater metadata for ${target}`);
  }
  return {
    edition: expectedEdition,
    version: update.version,
    target,
    downloadSizeBytes,
    installedSizeBytes,
  };
}

export function requireMatchingUpdateVersions(
  candidates: readonly AppUpdateCandidate[],
): string {
  if (candidates.length === 0) throw new Error("No update editions were found");
  const version = candidates[0].version;
  if (candidates.some((candidate) => candidate.version !== version)) {
    throw new Error("Core and Full updater versions do not match");
  }
  return version;
}

export function requiresEditionChange(
  currentEdition: UpdateEdition,
  selectedEdition: UpdateEdition,
): boolean {
  return currentEdition !== selectedEdition;
}

export async function closeUpdateResources(
  resources: Iterable<ClosableUpdateResource | null | undefined>,
): Promise<void> {
  const unique = [...new Set([...resources].filter(
    (resource): resource is ClosableUpdateResource => !!resource,
  ))];
  await Promise.allSettled(unique.map((resource) => resource.close()));
}

export function formatUpdateBytes(bytes: number, locale: string): string {
  const unit = bytes >= 1024 ** 3 ? "GB" : "MB";
  const divisor = unit === "GB" ? 1024 ** 3 : 1024 ** 2;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(bytes / divisor)} ${unit}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
