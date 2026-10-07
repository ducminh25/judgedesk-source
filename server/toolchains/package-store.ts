import fs from "node:fs";
import path from "node:path";
import { getJudgeDeskDistribution } from "../distribution.js";
import {
  normalizeWindowsVerbatimPath,
  RESOURCE_ROOT,
} from "../runtime.js";
import { loadBundledOfficialManifestSync } from "./manifest.js";
import {
  getDownloadedToolchainsDir,
  getExecutorCacheToolchainsDir,
} from "./storage.js";
import type {
  ToolchainCatalogEntry,
  ToolchainDescriptor,
  ToolchainKind,
  ToolchainKindEntrypoint,
  ToolchainPackageComponent,
  ToolchainPackageOrigin,
} from "./types.js";

export const TOOLCHAIN_PACKAGE_RECEIPT = ".judgedesk-package.json";
const MAX_RECEIPT_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type InstalledToolchainIntegrity = "verified-receipt" | "legacy-entrypoint";

export interface ToolchainPackageReceiptV1 {
  schemaVersion: 1;
  packageId: string;
  version: string;
  archiveSha256: string;
  entrypointComponentId: string;
  components: readonly ToolchainPackageComponent[];
}

export interface VerifiedToolchainPackageReceipt {
  root: string;
  receipt: ToolchainPackageReceiptV1;
}

export interface InstalledToolchainPackage {
  id: string;
  version: string;
  origin: ToolchainPackageOrigin;
  root: string;
  executablePath: string;
  componentId: string;
  packageDigest?: string;
  integrity: InstalledToolchainIntegrity;
  uninstallable: boolean;
}

export type InstalledToolchainPackageState =
  | {
      status: "installed";
      package: InstalledToolchainPackage;
    }
  | {
      status: "corrupt";
      origin: ToolchainPackageOrigin;
      root: string;
      diagnostic: string;
    }
  | {
      status: "not_installed";
    };

export type InstalledToolchainPackageInspector = (
  entry: ToolchainCatalogEntry,
  options?: { kind?: ToolchainKind },
) => InstalledToolchainPackageState;

export function createInstalledToolchainPackageInspector(
  inspect: InstalledToolchainPackageInspector = inspectInstalledToolchainPackage,
): InstalledToolchainPackageInspector {
  const snapshot = new Map<string, InstalledToolchainPackageState>();
  return (entry, options = {}) => {
    const kind = options.kind ?? entry.kind;
    const entrypoint = entry.entrypoints.find((candidate) => candidate.kind === kind);
    const key = [
      entry.id,
      entry.version,
      entry.platform,
      entry.arch,
      kind,
      entrypoint?.executableRelativePath ?? "",
    ].join("\0");
    const cached = snapshot.get(key);
    if (cached) return cached;
    const state = inspect(entry, { kind });
    snapshot.set(key, state);
    return state;
  };
}

export function getBuiltInToolchainsDir(
  resourceRoot: string = RESOURCE_ROOT,
): string {
  const override = process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR;
  return normalizeWindowsVerbatimPath(
    override ? path.resolve(override) : path.join(resourceRoot, "toolchains"),
  );
}

export function createToolchainPackageReceipt(
  descriptor: ToolchainDescriptor,
): ToolchainPackageReceiptV1 {
  const components = descriptor.components?.map((component) => ({
    id: component.id,
    kind: component.kind,
    relativePath: normalizeRelativePath(
      component.relativePath,
      `toolchain component '${component.id}'`,
      component.kind === "support-root",
    ),
    roles: [...component.roles],
  })) ?? [{
    id: "entrypoint",
    kind: "executable" as const,
    relativePath: normalizeRelativePath(
      descriptor.executableRelativePath,
      "toolchain executable",
    ),
    roles: descriptor.kind === "cpp"
      ? ["compiler" as const]
      : ["submission-runtime" as const, "checker-runtime" as const],
  }];
  return {
    schemaVersion: 1,
    packageId: descriptor.id,
    version: descriptor.version,
    archiveSha256: descriptor.sha256.toLowerCase(),
    entrypointComponentId: descriptor.entrypointComponentId ?? "entrypoint",
    components,
  };
}

export function encodeToolchainPackageReceipt(
  receipt: ToolchainPackageReceiptV1,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function writeToolchainPackageReceipt(
  packageRoot: string,
  descriptor: ToolchainDescriptor,
): void {
  const receiptPath = path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT);
  fs.writeFileSync(
    receiptPath,
    encodeToolchainPackageReceipt(createToolchainPackageReceipt(descriptor)),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export function readVerifiedToolchainPackageReceipt(
  entry: ToolchainCatalogEntry,
  packageRoot: string,
): VerifiedToolchainPackageReceipt {
  const rootMetadata = fs.lstatSync(packageRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Toolchain package root is not a regular directory.");
  }
  const canonicalRoot = fs.realpathSync(packageRoot);
  const receipt = readReceipt(
    path.join(canonicalRoot, TOOLCHAIN_PACKAGE_RECEIPT),
    entry,
    true,
  );
  if (!receipt) {
    throw new Error("Toolchain package receipt is missing.");
  }
  validateProductionReceipt(entry, receipt);
  return { root: canonicalRoot, receipt };
}

export function inspectInstalledToolchainPackage(
  entry: ToolchainCatalogEntry,
  options: {
    builtInRoot?: string;
    downloadedRoot?: string;
    executorCacheRoot?: string;
    kind?: ToolchainKind;
  } = {},
): InstalledToolchainPackageState {
  const requestedKind = options.kind ?? entry.kind;
  const requestedEntrypoint = entry.entrypoints.find(
    (candidate) => candidate.kind === requestedKind,
  );
  if (!requestedEntrypoint) return { status: "not_installed" };
  const roots: readonly {
    origin: ToolchainPackageOrigin;
    root: string;
    receiptRequired: boolean;
  }[] = [
    {
      origin: "built-in",
      root: normalizeWindowsVerbatimPath(
        options.builtInRoot ?? getBuiltInToolchainsDir(),
      ),
      receiptRequired: true,
    },
    {
      origin: "downloaded",
      root: normalizeWindowsVerbatimPath(
        options.downloadedRoot ?? getDownloadedToolchainsDir(),
      ),
      receiptRequired: false,
    },
    {
      origin: "downloaded",
      root: normalizeWindowsVerbatimPath(
        options.executorCacheRoot ?? getExecutorCacheToolchainsDir(),
      ),
      receiptRequired: true,
    },
  ];

  for (const candidate of roots) {
    if (!fs.existsSync(candidate.root)) continue;
    const candidateNames = [
      entry.id,
      `${entry.id}_${entry.version}`,
      `${entry.id}-${entry.version}`,
    ];
    for (const name of candidateNames) {
      const packageRoot = path.join(candidate.root, name);
      if (!fs.existsSync(packageRoot)) continue;
      try {
        return {
          status: "installed",
          package: inspectPackageRoot(
            entry,
            packageRoot,
            candidate.origin,
            candidate.receiptRequired,
            requestedEntrypoint,
          ),
        };
      } catch (error) {
        return {
          status: "corrupt",
          origin: candidate.origin,
          root: packageRoot,
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  return { status: "not_installed" };
}

function inspectPackageRoot(
  entry: ToolchainCatalogEntry,
  packageRoot: string,
  origin: ToolchainPackageOrigin,
  receiptRequired: boolean,
  requestedEntrypoint: ToolchainKindEntrypoint,
): InstalledToolchainPackage {
  const rootMetadata = fs.lstatSync(packageRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Toolchain package root is not a regular directory.");
  }
  const canonicalRoot = fs.realpathSync(packageRoot);
  const receiptPath = path.join(canonicalRoot, TOOLCHAIN_PACKAGE_RECEIPT);
  const receipt = readReceipt(receiptPath, entry, receiptRequired);
  if (receipt) {
    validateProductionReceipt(entry, receipt);
    validateInstalledComponents(canonicalRoot, receipt.components);
  }
  const executableRelativePath = normalizeRelativePath(
    requestedEntrypoint.executableRelativePath,
    "toolchain executable",
  );
  const executableComponent = receipt?.components.find((component) =>
    component.kind === "executable"
    && component.id === requestedEntrypoint.componentId
    && component.relativePath === executableRelativePath
  );
  if (receipt && !executableComponent) {
    throw new Error("Toolchain package receipt omits the catalog executable.");
  }
  const executablePath = fs.realpathSync(
    path.join(canonicalRoot, ...executableRelativePath.split("/")),
  );
  if (!isDescendantOrEqual(canonicalRoot, executablePath)) {
    throw new Error("Toolchain executable escapes its package root.");
  }
  if (!fs.statSync(executablePath).isFile()) {
    throw new Error("Toolchain executable is not a regular file.");
  }
  return {
    id: entry.id,
    version: entry.version,
    origin,
    root: canonicalRoot,
    executablePath,
    componentId: executableComponent?.id ?? "legacy-entrypoint",
    ...(receipt ? { packageDigest: receipt.archiveSha256 } : {}),
    integrity: receipt ? "verified-receipt" : "legacy-entrypoint",
    uninstallable: origin === "downloaded",
  };
}

function validateProductionReceipt(
  entry: ToolchainCatalogEntry,
  receipt: ToolchainPackageReceiptV1,
): void {
  if (getJudgeDeskDistribution() === "development") return;
  const descriptor = loadBundledOfficialManifestSync().find(
    (candidate) => candidate.id === entry.id,
  );
  if (!descriptor) {
    throw new Error(
      "Toolchain package is absent from the bundled signed manifest.",
    );
  }
  assertToolchainPackageReceiptMatchesDescriptor(receipt, descriptor);
}

export function assertToolchainPackageReceiptMatchesDescriptor(
  receipt: ToolchainPackageReceiptV1,
  descriptor: ToolchainDescriptor,
): void {
  const expected = createToolchainPackageReceipt(descriptor);
  if (encodeToolchainPackageReceipt(receipt)
    !== encodeToolchainPackageReceipt(expected)) {
    throw new Error(
      "Toolchain package receipt does not match the bundled signed manifest.",
    );
  }
}

function validateInstalledComponents(
  packageRoot: string,
  components: readonly ToolchainPackageComponent[],
): void {
  for (const component of components) {
    const componentPath = fs.realpathSync(
      component.relativePath === "."
        ? packageRoot
        : path.join(
            packageRoot,
            ...component.relativePath.split("/"),
          ),
    );
    if (!isDescendantOrEqual(packageRoot, componentPath)) {
      throw new Error(
        `Toolchain component '${component.id}' escapes its package root.`,
      );
    }
    const metadata = fs.statSync(componentPath);
    if (
      (component.kind === "executable" && !metadata.isFile())
      || (component.kind === "support-root" && !metadata.isDirectory())
    ) {
      throw new Error(
        `Toolchain component '${component.id}' has an invalid type.`,
      );
    }
  }
}

function readReceipt(
  receiptPath: string,
  entry: ToolchainCatalogEntry,
  required: boolean,
): ToolchainPackageReceiptV1 | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) {
      return null;
    }
    throw new Error("Toolchain package receipt is missing.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error("Toolchain package receipt has an invalid size.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Toolchain package receipt is not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("Toolchain package receipt must be an object.");
  }
  const expectedKeys = [
    "schemaVersion",
    "packageId",
    "version",
    "archiveSha256",
    "entrypointComponentId",
    "components",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("Toolchain package receipt has an invalid schema.");
  }
  if (
    value.schemaVersion !== 1
    || value.packageId !== entry.id
    || value.version !== entry.version
    || typeof value.archiveSha256 !== "string"
    || !SHA256_PATTERN.test(value.archiveSha256)
    || typeof value.entrypointComponentId !== "string"
    || !Array.isArray(value.components)
  ) {
    throw new Error("Toolchain package receipt does not match the catalog.");
  }
  const components = value.components.map((component, index) =>
    parseReceiptComponent(component, index)
  );
  if (
    components.length === 0
    || components.length > 64
    || new Set(components.map((component) => component.id)).size !== components.length
    || !components.some((component) =>
      component.id === value.entrypointComponentId
      && component.kind === "executable"
    )
  ) {
    throw new Error("Toolchain package receipt has invalid components.");
  }
  return {
    schemaVersion: 1,
    packageId: value.packageId,
    version: value.version,
    archiveSha256: value.archiveSha256,
    entrypointComponentId: value.entrypointComponentId,
    components,
  };
}

function parseReceiptComponent(
  value: unknown,
  index: number,
): ToolchainPackageComponent {
  if (!isRecord(value)) {
    throw new Error(`Toolchain package receipt component ${index} is invalid.`);
  }
  const expectedKeys = ["id", "kind", "relativePath", "roles"];
  if (
    Object.keys(value).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(value, key))
    || typeof value.id !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id)
    || (value.kind !== "executable" && value.kind !== "support-root")
    || typeof value.relativePath !== "string"
    || !Array.isArray(value.roles)
    || value.roles.length === 0
    || value.roles.some((role) =>
      role !== "compiler"
      && role !== "submission-runtime"
      && role !== "checker-runtime"
    )
    || new Set(value.roles).size !== value.roles.length
  ) {
    throw new Error(`Toolchain package receipt component ${index} is invalid.`);
  }
  return {
    id: value.id,
    kind: value.kind,
    relativePath: normalizeRelativePath(
      value.relativePath,
      `toolchain component '${value.id}'`,
      value.kind === "support-root",
    ),
    roles: value.roles,
  } as ToolchainPackageComponent;
}

function normalizeRelativePath(
  value: string,
  label: string,
  allowPackageRoot = false,
): string {
  const normalized = value.replaceAll("\\", "/");
  if (allowPackageRoot && normalized === ".") return normalized;
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-z]:/i.test(normalized)
    || normalized.split("/").some((component) =>
      !component || component === "." || component === ".."
    )
  ) {
    throw new Error(`${label} path is not a safe relative path.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}
