import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDescriptorForHost } from "../toolchains/manifest.js";
import { readVerifiedToolchainPackageReceipt } from "../toolchains/package-store.js";
import type {
  ResolvedToolchain,
  ToolchainCatalogEntry,
  ToolchainKind,
  ToolchainPackageRole,
} from "../toolchains/types.js";
import type { ExecutorToolchainIdentity } from "./protocol.js";
import { executorClient } from "./client.js";

export interface ExecutorWorkspace {
  id: string;
  path: string;
  relative(fileName: string): string;
  stage(sourcePath: string, fileName: string, executable?: boolean): string;
  stageDirectory(
    sourcePath: string,
    directoryName: string,
    limits?: ExecutorDirectoryLimits,
  ): string;
  dispose(): void;
}

export interface ExecutorDirectoryLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface ExecutorArtifact {
  executableId: string;
  path: string;
}

export interface CachedManagedToolchain extends ResolvedToolchain {
  executableId: string;
  root: string;
  toolchain?: ExecutorToolchainIdentity;
}

export interface CachedManagedSupportRoot {
  path: string;
  root: string;
  componentId: string;
}

const artifactCache = new Map<string, { fingerprint: string; artifact: ExecutorArtifact }>();
const inFlightToolchainImports = new Map<string, Promise<void>>();
const MANAGED_CACHE_SCHEMA = "4-receipt-digest";

export async function findCachedManagedToolchain(
  kind: ToolchainKind,
  packageDigest?: string,
): Promise<CachedManagedToolchain | null> {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) return null;
  const health = await executorClient.start();
  if (!health.ready) return null;
  const entrypoint = descriptorEntrypoint(descriptor, kind);
  const cacheId = managedCacheId(descriptor.id, descriptor.version);
  const root = path.join(health.executorRoot, "toolchains", cacheId);
  const marker = path.join(root, ".judgedesk-import-complete");
  const executablePath = path.join(root, entrypoint.executableRelativePath);
  const expectedMarker = managedCacheMarker(
    descriptor.id,
    descriptor.version,
    packageDigest,
  );
  try {
    const executableStat = fs.statSync(executablePath);
    if (!executableStat.isFile()) return null;
    if (fs.lstatSync(executablePath).isSymbolicLink()) {
      const targetPath = fs.realpathSync(executablePath);
      if (!isDescendant(root, targetPath)) return null;
    }
    if (fs.readFileSync(marker, "utf8") !== expectedMarker) return null;
    return {
      kind,
      source: "managed",
      executablePath,
      executableId: path.relative(health.executorRoot, executablePath).replaceAll("\\", "/"),
      root,
      version: descriptor.version,
      ready: true,
    };
  } catch {
    return null;
  }
}

export async function purgeCachedManagedToolchain(
  kind: ToolchainKind,
): Promise<void> {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) return;
  const health = await executorClient.start();
  if (!health.ready) return;
  const toolchainsRoot = path.join(health.executorRoot, "toolchains");
  const cacheRoot = path.join(
    toolchainsRoot,
    managedCacheId(descriptor.id, descriptor.version),
  );
  if (!isDescendant(toolchainsRoot, cacheRoot)) {
    throw new Error("Refusing to purge a toolchain cache outside the executor root.");
  }
  fs.rmSync(cacheRoot, { recursive: true, force: true });
}

export interface CreateExecutorWorkspaceOptions {
  rmSync?: (target: string, options?: fs.RmOptions) => void;
}

export async function createExecutorWorkspace(
  options?: CreateExecutorWorkspaceOptions,
): Promise<ExecutorWorkspace> {
  const health = await executorClient.start();
  if (!health.ready) throw new Error(health.diagnostics.join("; ") || "SECURE_RUNNER_UNAVAILABLE");
  const id = crypto.randomBytes(4).toString("hex");
  const workspacePath = path.join(health.executorRoot, "workspaces", id);
  fs.mkdirSync(workspacePath, { recursive: false });
  return {
    id,
    path: workspacePath,
    relative(fileName: string) {
      assertSafeRelative(fileName);
      return `workspaces/${id}/${fileName.replaceAll("\\", "/")}`;
    },
    stage(sourcePath: string, fileName: string, executable = false) {
      assertSafeSource(sourcePath);
      assertSafeRelative(fileName);
      const destination = path.join(workspacePath, fileName);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sourcePath, destination);
      if (executable && process.platform !== "win32") fs.chmodSync(destination, 0o700);
      return destination;
    },
    stageDirectory(
      sourcePath: string,
      directoryName: string,
      limits: ExecutorDirectoryLimits = {
        maxFiles: 1_024,
        maxBytes: 128 * 1024 * 1024,
      },
    ) {
      assertSafeRelative(directoryName);
      inspectRegularDirectory(sourcePath, limits);
      const destination = path.join(workspacePath, directoryName);
      cloneRegularDirectory(sourcePath, destination);
      return destination;
    },
    dispose() {
      try {
        (options?.rmSync ?? fs.rmSync)(workspacePath, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `Failed to clean up executor workspace at ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export interface SweepStaleQuarantinesOptions {
  removeSync?: (target: string, options?: fs.RmOptions) => void;
}

export function sweepStaleQuarantines(
  workspacesRoot: string,
  options?: SweepStaleQuarantinesOptions,
): void {
  if (!fs.existsSync(workspacesRoot)) return;
  const rmSync = options?.removeSync ?? ((target, opts) => fs.rmSync(target, opts));
  const entries = fs.readdirSync(workspacesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.includes(".quarantine.")) {
      const fullPath = path.join(workspacesRoot, entry.name);
      try {
        rmSync(fullPath, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `Failed to clean stale executor quarantine at ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export async function importManagedToolchain(
  kind: ToolchainKind,
  executablePath: string,
  version: string,
  packageRoot?: string,
  packageDigest?: string,
): Promise<{ executableId: string; executablePath: string; root: string }> {
  const health = await executorClient.start();
  const hostToolchains = path.resolve(
    process.env.USERPROFILE || os.homedir(),
    "AppData",
    "Local",
    "ThemisV2",
    "toolchains",
  );
  const rawManagedRoot = process.env.THEMIS_APP_DATA_DIR
    ? path.join(process.env.THEMIS_APP_DATA_DIR, "toolchains")
    : path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ThemisV2", "toolchains");
  const managedRoot = fs.existsSync(rawManagedRoot)
    ? fs.realpathSync(rawManagedRoot)
    : rawManagedRoot;
  const canonicalHostToolchains = fs.existsSync(hostToolchains)
    ? fs.realpathSync(hostToolchains)
    : hostToolchains;
  const canonicalExecutable = fs.realpathSync(executablePath);
  if (
    process.platform === "win32"
    && !isDescendant(managedRoot, canonicalExecutable)
    && !isDescendant(canonicalHostToolchains, canonicalExecutable)
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  const entrypoint = descriptorEntrypoint(descriptor, kind);
  const sourceRoot = managedToolchainSourceRoot(
    path.resolve(executablePath),
    entrypoint.executableRelativePath,
    packageRoot,
  );
  const canonicalSourceRoot = fs.realpathSync(sourceRoot);
  const executableWithinSource = path.relative(canonicalSourceRoot, canonicalExecutable);
  if (executableWithinSource.startsWith("..") || path.isAbsolute(executableWithinSource)) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const cacheId = managedCacheId(descriptor.id, version);
  const destinationRoot = path.join(health.executorRoot, "toolchains", cacheId);
  const marker = path.join(destinationRoot, ".judgedesk-import-complete");
  const expectedMarker = managedCacheMarker(
    descriptor.id,
    version,
    packageDigest,
  );
  if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== expectedMarker) {
    const importKey = destinationRoot.toLowerCase();
    let activeImport = inFlightToolchainImports.get(importKey);
    if (!activeImport) {
      activeImport = (async () => {
        if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === expectedMarker) {
          return;
        }
        const staging = `${destinationRoot}.staging.${process.pid}.${crypto.randomUUID()}`;
        await fs.promises.rm(staging, { recursive: true, force: true });
        try {
          await fs.promises.cp(sourceRoot, staging, {
            recursive: true,
            dereference: true,
            force: false,
          });
          rewriteManagedToolchainSymlinks(sourceRoot, staging);
          await fs.promises.writeFile(
            path.join(staging, ".judgedesk-import-complete"),
            expectedMarker,
            "utf8",
          );
          await fs.promises.rm(destinationRoot, { recursive: true, force: true });
          await fs.promises.rename(staging, destinationRoot);
        } catch (error) {
          await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      })().finally(() => {
        inFlightToolchainImports.delete(importKey);
      });
      inFlightToolchainImports.set(importKey, activeImport);
    }
    await activeImport;
  }
  const relativeExecutable = entrypoint.executableRelativePath;
  const cachedExecutable = path.join(destinationRoot, relativeExecutable);
  if (!fs.existsSync(cachedExecutable)) throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  if (!isDescendant(destinationRoot, fs.realpathSync(cachedExecutable))) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  return {
    executableId: path.relative(health.executorRoot, cachedExecutable).replaceAll("\\", "/"),
    executablePath: cachedExecutable,
    root: destinationRoot,
  };
}

export async function prepareManagedToolchainExecutable(
  kind: ToolchainKind,
  resolved: ResolvedToolchain,
): Promise<CachedManagedToolchain> {
  if (
    resolved.packageOrigin === "downloaded"
    && (!resolved.packageRoot
      || !resolved.packageDigest
      || !resolved.packageComponentId)
    && (kind === "cpp" || kind === "c" || kind === "python")
  ) {
    const cached = await findCachedManagedToolchain(kind);
    if (cached && sameFilePath(cached.executablePath, resolved.executablePath)) {
      return cached;
    }
    return {
      ...resolved,
      ...await importManagedToolchain(
        kind,
        resolved.executablePath,
        resolved.version,
        resolved.packageRoot,
      ),
    };
  }
  return prepareManagedToolchainComponent(
    kind,
    resolved,
    resolved.packageComponentId,
  );
}

export async function prepareManagedToolchainComponent(
  kind: ToolchainKind,
  resolved: ResolvedToolchain,
  requestedComponentId: string | undefined,
  expectedRole?: ToolchainPackageRole,
): Promise<CachedManagedToolchain> {
  if (
    resolved.kind !== kind
    || resolved.source !== "managed"
    || !resolved.ready
    || !resolved.packageRoot
    || !resolved.packageDigest
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor || descriptor.id !== path.basename(resolved.packageRoot)) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const installed = readVerifiedToolchainPackageReceipt(
    descriptor,
    resolved.packageRoot,
  );
  if (installed.receipt.archiveSha256 !== resolved.packageDigest) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const componentId = requestedComponentId
    ?? installed.receipt.entrypointComponentId;
  const component = installed.receipt.components.find(
    (candidate) =>
      candidate.id === componentId
      && candidate.kind === "executable",
  );
  if (
    !component
    || (expectedRole && !component.roles.includes(expectedRole))
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }

  if (
    resolved.packageOrigin === "built-in"
  ) {
    const canonicalRoot = installed.root;
    const lexicalExecutable = path.join(
      canonicalRoot,
      ...component.relativePath.split("/"),
    );
    const canonicalExecutable = fs.realpathSync(
      lexicalExecutable,
    );
    if (!isDescendant(canonicalRoot, canonicalExecutable)) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    return {
      ...resolved,
      executablePath: canonicalExecutable,
      // The executor authenticates the signed receipt component path, then
      // canonicalizes it independently. Keep that lexical identity even when
      // an upstream package uses an internal entrypoint symlink.
      executableId:
        `builtin-toolchains/${descriptor.id}/${component.relativePath}`,
      root: canonicalRoot,
      toolchain: {
        packageId: descriptor.id,
        packageDigest: resolved.packageDigest,
        componentId,
      },
    };
  }

  const cached = await findCachedManagedToolchain(kind, resolved.packageDigest);
  const preparedEntrypoint = cached
    && sameFilePath(cached.executablePath, resolved.executablePath)
    ? cached
    : {
        ...resolved,
        ...await importManagedToolchain(
          kind,
          resolved.executablePath,
          resolved.version,
          resolved.packageRoot,
          resolved.packageDigest,
        ),
      };
  const cachedReceipt = readVerifiedToolchainPackageReceipt(
    descriptor,
    preparedEntrypoint.root,
  );
  if (cachedReceipt.receipt.archiveSha256 !== resolved.packageDigest) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const cachedComponent = cachedReceipt.receipt.components.find(
    (candidate) =>
      candidate.id === componentId
      && candidate.kind === "executable"
      && (!expectedRole || candidate.roles.includes(expectedRole)),
  );
  if (!cachedComponent) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const cachedLexicalExecutable = path.join(
    cachedReceipt.root,
    ...cachedComponent.relativePath.split("/"),
  );
  const cachedExecutable = fs.realpathSync(cachedLexicalExecutable);
  if (!isDescendant(cachedReceipt.root, cachedExecutable)) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const health = await executorClient.start();
  if (!health.ready) {
    throw new Error(
      health.diagnostics.join("; ") || "SECURE_RUNNER_UNAVAILABLE",
    );
  }
  const executableId = executorRelativeCanonicalPath(
    health.executorRoot,
    cachedLexicalExecutable,
  );
  return {
    ...resolved,
    executablePath: cachedExecutable,
    executableId,
    root: cachedReceipt.root,
    toolchain: {
      packageId: descriptor.id,
      packageDigest: resolved.packageDigest,
      componentId,
    },
  };
}

export async function prepareManagedToolchainSupportRoot(
  kind: ToolchainKind,
  resolved: ResolvedToolchain,
  requestedComponentId: string,
  expectedRole: ToolchainPackageRole,
): Promise<CachedManagedSupportRoot> {
  const prepared = await prepareManagedToolchainComponent(
    kind,
    resolved,
    resolved.packageComponentId,
    expectedRole,
  );
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const installed = readVerifiedToolchainPackageReceipt(
    descriptor,
    prepared.root,
  );
  if (installed.receipt.archiveSha256 !== resolved.packageDigest) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const component = installed.receipt.components.find(
    (candidate) =>
      candidate.id === requestedComponentId
      && candidate.kind === "support-root"
      && candidate.roles.includes(expectedRole),
  );
  if (!component) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const componentPath = fs.realpathSync(
    component.relativePath === "."
      ? installed.root
      : path.join(
          installed.root,
          ...component.relativePath.split("/"),
        ),
  );
  if (
    componentPath !== installed.root
    && !isDescendant(installed.root, componentPath)
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  if (!fs.statSync(componentPath).isDirectory()) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  return {
    path: componentPath,
    root: installed.root,
    componentId: component.id,
  };
}

export function rewriteManagedToolchainSymlinks(
  sourceRoot: string,
  destinationRoot: string,
): void {
  const canonicalSourceRoot = fs.realpathSync(sourceRoot);
  const resolvedDestinationRoot = path.resolve(destinationRoot);
  const pending = [path.resolve(sourceRoot)];

  while (pending.length > 0) {
    const sourceDirectory = pending.pop()!;
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      if (entry.isDirectory()) {
        pending.push(sourcePath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;

      const canonicalTarget = fs.realpathSync(sourcePath);
      if (!isDescendant(canonicalSourceRoot, canonicalTarget)) {
        throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
      }
      const sourceRelativePath = path.relative(path.resolve(sourceRoot), sourcePath);
      const targetRelativePath = path.relative(canonicalSourceRoot, canonicalTarget);
      const destinationPath = path.join(resolvedDestinationRoot, sourceRelativePath);
      const destinationTarget = path.join(resolvedDestinationRoot, targetRelativePath);
      // The copied entry may still be a rebased symlink to the source package until the
      // replacement below. Validate where we will write lexically; source targets were
      // already canonicalized and constrained to canonicalSourceRoot above.
      if (!isLexicalDescendant(resolvedDestinationRoot, destinationPath)
        || !isLexicalDescendant(resolvedDestinationRoot, destinationTarget)) {
        throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
      }

      fs.rmSync(destinationPath, { recursive: true, force: true });
      const internalTarget = path.relative(path.dirname(destinationPath), destinationTarget);
      fs.symlinkSync(
        internalTarget,
        destinationPath,
        fs.statSync(canonicalTarget).isDirectory() ? "dir" : "file",
      );
    }
  }
}

export function managedToolchainSourceRoot(
  executablePath: string,
  executableRelativePath: string,
  packageRoot?: string,
): string {
  const components = executableRelativePath.split(/[\\/]/).filter(Boolean);
  if (components.length === 0 || components.some((component) => component === "." || component === "..")) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  if (packageRoot) {
    const canonicalRoot = fs.realpathSync(packageRoot);
    const catalogEntrypoint = path.resolve(canonicalRoot, ...components);
    const canonicalCatalogEntrypoint = fs.realpathSync(catalogEntrypoint);
    const canonicalExecutable = fs.realpathSync(executablePath);
    if (
      !isDescendant(canonicalRoot, canonicalCatalogEntrypoint)
      || !sameFilePath(canonicalCatalogEntrypoint, canonicalExecutable)
    ) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    return canonicalRoot;
  }
  let root = path.resolve(executablePath);
  for (let index = 0; index < components.length; index += 1) root = path.dirname(root);
  if (path.resolve(root, ...components).toLowerCase() !== path.resolve(executablePath).toLowerCase()) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  return root;
}

export async function importExecutorArtifact(sourcePath: string): Promise<ExecutorArtifact> {
  const health = await executorClient.start();
  if (!health.ready) throw new Error(health.diagnostics.join("; ") || "SECURE_RUNNER_UNAVAILABLE");
  assertSafeSource(sourcePath);
  const canonical = fs.realpathSync(sourcePath);
  const metadata = fs.statSync(canonical);
  const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
  const cached = artifactCache.get(canonical);
  if (cached?.fingerprint === fingerprint && fs.existsSync(cached.artifact.path)) {
    return cached.artifact;
  }

  const digest = sha256File(canonical);
  const extension = process.platform === "win32" ? ".exe" : "";
  const fileName = `${digest}${extension}`;
  const artifactRoot = path.join(health.executorRoot, "artifacts");
  const destination = path.join(artifactRoot, fileName);
  if (!fs.existsSync(destination)) {
    const staging = path.join(artifactRoot, `${fileName}.${process.pid}.${crypto.randomUUID()}.staging`);
    try {
      fs.copyFileSync(canonical, staging, fs.constants.COPYFILE_EXCL);
      if (sha256File(staging) !== digest) throw new Error("Executor artifact changed while it was staged.");
      if (process.platform !== "win32") fs.chmodSync(staging, 0o500);
      try {
        fs.renameSync(staging, destination);
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
      }
    } finally {
      fs.rmSync(staging, { force: true });
    }
  }
  const artifact = {
    executableId: `artifacts/${fileName}`,
    path: destination,
  };
  artifactCache.set(canonical, { fingerprint, artifact });
  return artifact;
}

function sha256File(filePath: string): string {
  const digest = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return digest.digest("hex");
}

function assertSafeSource(sourcePath: string): void {
  const metadata = fs.lstatSync(sourcePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Executor staging accepts regular non-symlink files only.");
}

function assertSafeRelative(value: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).some((component) => !component || component === "." || component === "..")) {
    throw new Error("Executor workspace path is not normalized.");
  }
}

export function isDescendant(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalizeForContainment(root);
  const canonicalCandidate = canonicalizeForContainment(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Convert a lexical path rooted at a canonical package directory into the
 * executor protocol namespace. macOS may report the executor root through the
 * `/var` alias while `realpath` returns `/private/var`; comparing those two
 * spellings directly would manufacture a parent-relative executableId.
 *
 * Do not canonicalize the candidate itself: signed package receipts grant the
 * lexical component path, which may legitimately be an internal symlink.
 */
export function executorRelativeCanonicalPath(
  executorRoot: string,
  canonicalCandidate: string,
): string {
  const relative = path
    .relative(fs.realpathSync(executorRoot), path.resolve(canonicalCandidate))
    .replaceAll("\\", "/");
  assertSafeRelative(relative);
  return relative;
}

export function managedCacheMarker(
  packageId: string,
  version: string,
  packageDigest?: string,
): string {
  const digest = packageDigest ?? "legacy";
  if (digest !== "legacy" && !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Managed cache digest is not a lowercase SHA-256 value.");
  }
  return `${MANAGED_CACHE_SCHEMA}\n${packageId}\n${version}\n${digest}\n`;
}

export function inspectRegularDirectory(
  sourcePath: string,
  limits: ExecutorDirectoryLimits,
): { files: number; bytes: number } {
  if (
    !Number.isSafeInteger(limits.maxFiles)
    || limits.maxFiles < 1
    || !Number.isSafeInteger(limits.maxBytes)
    || limits.maxBytes < 1
  ) {
    throw new Error("Directory staging limits are invalid.");
  }
  const rootMetadata = fs.lstatSync(sourcePath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(
      "Executor directory staging accepts a regular non-symlink directory only.",
    );
  }
  let files = 0;
  let bytes = 0;
  const pending = [sourcePath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Executor directory staging rejects symbolic links.");
      }
      if (metadata.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Executor directory staging accepts regular files only.");
      }
      files += 1;
      bytes += metadata.size;
      if (files > limits.maxFiles || bytes > limits.maxBytes) {
        throw new Error("Executor directory staging limits were exceeded.");
      }
    }
  }
  return { files, bytes };
}

export function cloneRegularDirectory(
  sourcePath: string,
  destinationPath: string,
): void {
  if (fs.existsSync(destinationPath)) {
    throw new Error("Executor directory staging destination already exists.");
  }
  try {
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
      // COPYFILE_FICLONE asks APFS/ReFS-capable hosts for copy-on-write and
      // safely falls back to a byte copy elsewhere. Never use hard links:
      // cache writes must not mutate the signed package or another run.
      mode: fs.constants.COPYFILE_FICLONE,
    });
  } catch (error) {
    fs.rmSync(destinationPath, { recursive: true, force: true });
    throw error;
  }
}

function isLexicalDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function canonicalizeForContainment(value: string): string {
  let existingPath = path.resolve(value);
  const missingComponents: string[] = [];

  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) break;
    missingComponents.unshift(path.basename(existingPath));
    existingPath = parent;
  }

  const canonicalExistingPath = fs.realpathSync(existingPath);
  return path.resolve(canonicalExistingPath, ...missingComponents);
}

function managedCacheId(packageId: string, version: string): string {
  return `${packageId}_${version.replaceAll(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function descriptorEntrypoint(
  descriptor: ToolchainCatalogEntry,
  kind: ToolchainKind,
) {
  const entrypoint = descriptor.entrypoints.find(
    (candidate) => candidate.kind === kind,
  );
  if (!entrypoint) throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  return entrypoint;
}

function sameFilePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left).toLowerCase()
      === fs.realpathSync(right).toLowerCase();
  } catch {
    return false;
  }
}
