import {
  ToolchainCatalogEntry,
  ToolchainDescriptor,
  ToolchainManifestDocument,
} from "./types.js";

const DEFAULT_MANIFEST_URL =
  "https://github.com/ducminh25/themis-v2-downloads/releases/download/toolchains-v1/toolchains-manifest.json";
const MANIFEST_CACHE_MS = 5 * 60 * 1000;

export const TOOLCHAIN_CATALOG: ToolchainCatalogEntry[] = [
  {
    id: "gcc-windows-x64",
    kind: "cpp",
    version: "14.2.0",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "bin/g++.exe",
    licenseFiles: ["COPYING3", "COPYING.RUNTIME", "SOURCE.txt"],
  },
  {
    id: "python-windows-x64",
    kind: "python",
    version: "3.12.13",
    platform: "win32",
    arch: "x64",
    archiveFormat: "zip",
    executableRelativePath: "python.exe",
    licenseFiles: ["LICENSE.txt"],
  },
  {
    id: "python-macos-x64",
    kind: "python",
    version: "3.12.13",
    platform: "darwin",
    arch: "x64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/python3",
    licenseFiles: ["lib/python3.12/LICENSE.txt"],
  },
  {
    id: "python-macos-arm64",
    kind: "python",
    version: "3.12.13",
    platform: "darwin",
    arch: "arm64",
    archiveFormat: "tar.gz",
    executableRelativePath: "bin/python3",
    licenseFiles: ["lib/python3.12/LICENSE.txt"],
  },
];

let cachedManifest: {
  expiresAt: number;
  manifestUrl: string;
  toolchains: ToolchainDescriptor[];
} | null = null;

function mappedArchitecture(arch: string): string {
  return arch === "x86_64" || arch === "amd64"
    ? "x64"
    : arch === "aarch64"
      ? "arm64"
      : arch;
}

function catalogEntry(id: string): ToolchainCatalogEntry {
  const entry = TOOLCHAIN_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown toolchain package '${id}'.`);
  return entry;
}

function validateDescriptor(value: unknown): ToolchainDescriptor {
  if (!value || typeof value !== "object")
    throw new Error("Toolchain entry must be an object.");
  const candidate = value as Record<string, unknown>;
  const expected = catalogEntry(String(candidate.id || ""));

  for (const field of [
    "kind",
    "version",
    "platform",
    "arch",
    "archiveFormat",
    "executableRelativePath",
  ] as const) {
    if (candidate[field] !== expected[field]) {
      throw new Error(`Toolchain '${expected.id}' has an invalid ${field}.`);
    }
  }

  if (typeof candidate.downloadUrl !== "string")
    throw new Error(`Toolchain '${expected.id}' has no download URL.`);
  const downloadUrl = new URL(candidate.downloadUrl);
  if (downloadUrl.protocol !== "https:")
    throw new Error(`Toolchain '${expected.id}' must use HTTPS.`);
  if (!/^[a-f0-9]{64}$/i.test(String(candidate.sha256 || ""))) {
    throw new Error(
      `Toolchain '${expected.id}' has an invalid SHA-256 digest.`,
    );
  }
  const sizeBytes = Number(candidate.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Toolchain '${expected.id}' has an invalid package size.`);
  }

  return {
    ...expected,
    downloadUrl: downloadUrl.toString(),
    sha256: String(candidate.sha256).toLowerCase(),
    sizeBytes,
  };
}

export function validateManifestDocument(
  value: unknown,
): ToolchainDescriptor[] {
  if (!value || typeof value !== "object")
    throw new Error("Toolchain manifest must be an object.");
  const document = value as Partial<ToolchainManifestDocument>;
  if (document.schemaVersion !== 1)
    throw new Error("Unsupported toolchain manifest schema.");
  if (!Array.isArray(document.toolchains))
    throw new Error("Toolchain manifest contains no package list.");

  const validated = document.toolchains.map(validateDescriptor);
  if (new Set(validated.map((entry) => entry.id)).size !== validated.length) {
    throw new Error("Toolchain manifest contains duplicate package IDs.");
  }
  return validated;
}

export async function loadOfficialManifest(
  options: {
    forceRefresh?: boolean;
    fetchImpl?: typeof fetch;
    manifestUrl?: string;
  } = {},
): Promise<ToolchainDescriptor[]> {
  const now = Date.now();
  const manifestUrl =
    options.manifestUrl ||
    process.env.THEMIS_TOOLCHAIN_MANIFEST_URL ||
    DEFAULT_MANIFEST_URL;
  if (
    !options.forceRefresh &&
    cachedManifest &&
    cachedManifest.manifestUrl === manifestUrl &&
    cachedManifest.expiresAt > now
  ) {
    return cachedManifest.toolchains;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(manifestUrl, {
    headers: { Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Toolchain manifest request failed (${response.status}).`);

  const toolchains = validateManifestDocument(await response.json());
  cachedManifest = {
    expiresAt: now + MANIFEST_CACHE_MS,
    manifestUrl,
    toolchains,
  };
  return toolchains;
}

export function getDescriptorForHost(
  platform: string,
  arch: string,
  kind: string,
): ToolchainCatalogEntry | undefined {
  const mappedArch = mappedArchitecture(arch);
  return TOOLCHAIN_CATALOG.find(
    (entry) =>
      entry.platform === platform &&
      entry.arch === mappedArch &&
      entry.kind === kind,
  );
}
