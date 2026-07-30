import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDescriptorForHost } from "../toolchains/manifest.js";
import type { ResolvedToolchain, ToolchainKind } from "../toolchains/types.js";
import type { ExecutorToolchainIdentity } from "./protocol.js";
import { executorClient } from "./client.js";

export interface ExecutorWorkspace {
  id: string;
  path: string;
  relative(fileName: string): string;
  stage(sourcePath: string, fileName: string, executable?: boolean): string;
  dispose(): void;
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

const artifactCache = new Map<string, { fingerprint: string; artifact: ExecutorArtifact }>();
const MANAGED_CACHE_SCHEMA = "3-internal-symlinks";

export async function findCachedManagedToolchain(
  kind: ToolchainKind,
): Promise<CachedManagedToolchain | null> {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) return null;
  const health = await executorClient.start();
  if (!health.ready) return null;
  const cacheId = managedCacheId(kind, descriptor.version);
  const root = path.join(health.executorRoot, "toolchains", cacheId);
  const marker = path.join(root, ".judgedesk-import-complete");
  const executablePath = path.join(root, descriptor.executableRelativePath);
  const expectedMarker = `${MANAGED_CACHE_SCHEMA}\n${kind}\n${descriptor.version}\n`;
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
    managedCacheId(kind, descriptor.version),
  );
  if (!isDescendant(toolchainsRoot, cacheRoot)) {
    throw new Error("Refusing to purge a toolchain cache outside the executor root.");
  }
  fs.rmSync(cacheRoot, { recursive: true, force: true });
}

export async function createExecutorWorkspace(): Promise<ExecutorWorkspace> {
  const health = await executorClient.start();
  if (!health.ready) throw new Error(health.diagnostics.join("; ") || "SECURE_RUNNER_UNAVAILABLE");
  const id = crypto.randomUUID().replaceAll("-", "_");
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
    dispose() {
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      } catch (error) {
        const quarantine = `${workspacePath}.quarantine.${Date.now()}`;
        try { fs.renameSync(workspacePath, quarantine); } catch { /* Startup cleanup retries it. */ }
        console.warn(`[Executor] Workspace cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export async function importManagedToolchain(
  kind: "cpp" | "python",
  executablePath: string,
  version: string,
): Promise<{ executableId: string; executablePath: string; root: string }> {
  const health = await executorClient.start();
  const managedRoot = path.resolve(process.env.LOCALAPPDATA || "", "ThemisV2", "toolchains");
  const canonicalExecutable = fs.realpathSync(executablePath);
  if (process.platform === "win32" && !isDescendant(managedRoot, canonicalExecutable)) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  const sourceRoot = managedToolchainSourceRoot(
    path.resolve(executablePath),
    descriptor.executableRelativePath,
  );
  const canonicalSourceRoot = fs.realpathSync(sourceRoot);
  const executableWithinSource = path.relative(canonicalSourceRoot, canonicalExecutable);
  if (executableWithinSource.startsWith("..") || path.isAbsolute(executableWithinSource)) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const cacheId = managedCacheId(kind, version);
  const destinationRoot = path.join(health.executorRoot, "toolchains", cacheId);
  const marker = path.join(destinationRoot, ".judgedesk-import-complete");
  const expectedMarker = `${MANAGED_CACHE_SCHEMA}\n${kind}\n${version}\n`;
  if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== expectedMarker) {
    const staging = `${destinationRoot}.staging.${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(sourceRoot, staging, { recursive: true, dereference: true, force: false });
    rewriteManagedToolchainSymlinks(sourceRoot, staging);
    fs.writeFileSync(path.join(staging, ".judgedesk-import-complete"), expectedMarker, "utf8");
    fs.rmSync(destinationRoot, { recursive: true, force: true });
    fs.renameSync(staging, destinationRoot);
  }
  const relativeExecutable = descriptor.executableRelativePath;
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
  kind: "cpp" | "python",
  resolved: ResolvedToolchain,
): Promise<CachedManagedToolchain> {
  if (
    resolved.source === "managed"
    && resolved.packageOrigin === "built-in"
    && resolved.packageRoot
    && resolved.packageDigest
    && resolved.packageComponentId
  ) {
    const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
    if (!descriptor || descriptor.id !== path.basename(resolved.packageRoot)) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    const canonicalRoot = fs.realpathSync(resolved.packageRoot);
    const canonicalExecutable = fs.realpathSync(resolved.executablePath);
    if (!isDescendant(canonicalRoot, canonicalExecutable)) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    const relativeExecutable = path
      .relative(canonicalRoot, canonicalExecutable)
      .replaceAll("\\", "/");
    return {
      ...resolved,
      executablePath: canonicalExecutable,
      executableId: `builtin-toolchains/${descriptor.id}/${relativeExecutable}`,
      root: canonicalRoot,
      toolchain: {
        packageId: descriptor.id,
        packageDigest: resolved.packageDigest,
        componentId: resolved.packageComponentId,
      },
    };
  }

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
    ),
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
): string {
  const components = executableRelativePath.split(/[\\/]/).filter(Boolean);
  if (components.length === 0 || components.some((component) => component === "." || component === "..")) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
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

function managedCacheId(kind: ToolchainKind, version: string): string {
  return `${kind}_${version.replaceAll(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function sameFilePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left).toLowerCase()
      === fs.realpathSync(right).toLowerCase();
  } catch {
    return false;
  }
}
