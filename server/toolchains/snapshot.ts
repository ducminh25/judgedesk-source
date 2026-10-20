import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../executor/client.js";
import type { ToolchainKind } from "./types.js";

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_CACHE_PREFIX = "local";
const SNAPSHOT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_FILES = 200_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_ORPHAN_MINIMUM_AGE_MS = 5 * 60 * 1000;
const SNAPSHOT_MARKER = ".judgedesk-local-snapshot.json";
const STAGING_NAME_PATTERN = /^\.local_(cpp|python)_(?:pending|[a-f0-9]{64})\.([1-9]\d{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.staging$/;

export interface DirectoryTreeInspection {
  canonicalRoot: string;
  treeDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface DirectoryTreeEstimate {
  canonicalRoot: string;
  fileCount: number;
  totalBytes: number;
  metadataDigest: string;
}

export interface DirectoryTreeLimits {
  maxFiles?: number;
  maxBytes?: number;
}

export interface LocalToolchainSnapshot extends DirectoryTreeInspection {
  kind: ToolchainKind;
  root: string;
  payloadRoot: string;
  executablePath: string;
  executableId: string;
  relativeExecutablePath: string;
  created?: boolean;
}

interface LocalSnapshotMarker {
  schemaVersion: 1;
  kind: ToolchainKind;
  snapshotDigest: string;
  relativeExecutablePath: string;
  fileCount: number;
  totalBytes: number;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-z]:/i.test(normalized)
    || normalized.split("/").some((component) => !component || component === "." || component === "..")
  ) {
    throw new Error("Snapshot executable path is not a normalized relative path.");
  }
  return normalized;
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function hashStableFile(filePath: string): Promise<{ digest: string; size: number }> {
  const before = await fs.promises.stat(filePath, { bigint: true });
  if (!before.isFile()) throw new Error(`Snapshot entry is not a regular file: ${filePath}`);
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const after = await fs.promises.stat(filePath, { bigint: true });
  if (
    before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.dev !== after.dev
    || before.ino !== after.ino
  ) {
    throw new Error(`TOOLCHAIN_DRIFTED: snapshot source changed while hashing '${filePath}'.`);
  }
  return { digest: hash.digest("hex"), size: Number(after.size) };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await transform(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function inspectDirectoryTree(
  root: string,
  limits: DirectoryTreeLimits = {},
): Promise<DirectoryTreeInspection> {
  if (!path.isAbsolute(root)) throw new Error("Snapshot root must be absolute.");
  const requestedMetadata = await fs.promises.lstat(root);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error("Snapshot root must be a regular directory, not a link.");
  }
  const canonicalRoot = await fs.promises.realpath(root);
  const canonicalMetadata = await fs.promises.lstat(canonicalRoot);
  if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink()) {
    throw new Error("Snapshot canonical root is not a trusted directory.");
  }
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Snapshot file limit is invalid.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Snapshot byte limit is invalid.");
  }

  const records: Array<
    | { kind: "directory"; relative: string }
    | { kind: "file"; relative: string; absolute: string; observedSize: number }
  > = [];
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: canonicalRoot, relative: "" },
  ];
  let fileCount = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = (await fs.promises.readdir(current.absolute, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    const directories: Array<{ absolute: string; relative: string }> = [];
    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      const metadata = await fs.promises.lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Snapshot source contains a symbolic link or junction: ${relative}`);
      }
      if (metadata.isDirectory()) {
        records.push({ kind: "directory", relative });
        directories.push({ absolute, relative });
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Snapshot source contains an unsupported entry: ${relative}`);
      }
      fileCount += 1;
      if (fileCount > maxFiles) throw new Error("Snapshot source exceeds the file-count limit.");
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        throw new Error("Snapshot source exceeds the byte limit.");
      }
      records.push({
        kind: "file",
        relative,
        absolute,
        observedSize: metadata.size,
      });
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      pending.push(directories[index]);
    }
  }
  const fileRecords = records.filter(
    (record): record is Extract<(typeof records)[number], { kind: "file" }> =>
      record.kind === "file",
  );
  const concurrency = Math.max(
    1,
    Math.min(4, Math.floor(os.availableParallelism() / 2)),
  );
  const fileHashes = await mapConcurrent(
    fileRecords,
    concurrency,
    (record) => hashStableFile(record.absolute),
  );
  const hashesByPath = new Map(
    fileRecords.map((record, index) => {
      const hashed = fileHashes[index];
      if (hashed.size !== record.observedSize) {
        throw new Error(
          `TOOLCHAIN_DRIFTED: snapshot entry changed while hashing '${record.absolute}'.`,
        );
      }
      return [record.relative, hashed] as const;
    }),
  );
  const tree = crypto.createHash("sha256");
  tree.update("judgedesk-local-snapshot-tree-v1\0");
  for (const record of records) {
    if (record.kind === "directory") {
      tree.update(`D\0${record.relative}\0`);
    } else {
      const file = hashesByPath.get(record.relative)!;
      tree.update(`F\0${record.relative}\0${file.size}\0${file.digest}\0`);
    }
  }
  return {
    canonicalRoot,
    treeDigest: tree.digest("hex"),
    fileCount,
    totalBytes,
  };
}

export async function estimateDirectoryTree(
  root: string,
  limits: DirectoryTreeLimits = {},
): Promise<DirectoryTreeEstimate> {
  if (!path.isAbsolute(root)) throw new Error("Snapshot root must be absolute.");
  const requestedMetadata = await fs.promises.lstat(root);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error("Snapshot root must be a regular directory, not a link.");
  }
  const canonicalRoot = await fs.promises.realpath(root);
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Snapshot file limit is invalid.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Snapshot byte limit is invalid.");
  }
  const pending = [canonicalRoot];
  const metadataHash = crypto.createHash("sha256");
  metadataHash.update("judgedesk-local-snapshot-metadata-v1\0");
  let fileCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const metadata = await fs.promises.lstat(entryPath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Snapshot source contains a symbolic link or junction: ${path.relative(canonicalRoot, entryPath)}`,
        );
      }
      if (metadata.isDirectory()) {
        metadataHash.update(`D\0${path.relative(canonicalRoot, entryPath).replaceAll("\\", "/")}\0`);
        pending.push(entryPath);
      } else if (metadata.isFile()) {
        fileCount += 1;
        totalBytes += Number(metadata.size);
        metadataHash.update(
          `F\0${path.relative(canonicalRoot, entryPath).replaceAll("\\", "/")}\0${metadata.size}\0${metadata.mtimeNs}\0${metadata.dev}\0${metadata.ino}\0`,
        );
        if (fileCount > maxFiles) throw new Error("Snapshot source exceeds the file-count limit.");
        if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
          throw new Error("Snapshot source exceeds the byte limit.");
        }
      } else {
        throw new Error(
          `Snapshot source contains an unsupported entry: ${path.relative(canonicalRoot, entryPath)}`,
        );
      }
    }
  }
  return {
    canonicalRoot,
    fileCount,
    totalBytes,
    metadataDigest: metadataHash.digest("hex"),
  };
}

function canonicalMarker(marker: LocalSnapshotMarker): string {
  return `${JSON.stringify({
    fileCount: marker.fileCount,
    kind: marker.kind,
    relativeExecutablePath: marker.relativeExecutablePath,
    schemaVersion: marker.schemaVersion,
    snapshotDigest: marker.snapshotDigest,
    totalBytes: marker.totalBytes,
  })}\n`;
}

function cacheName(kind: ToolchainKind, digest: string): string {
  if (!SNAPSHOT_DIGEST_PATTERN.test(digest)) throw new Error("Snapshot digest is invalid.");
  return `${SNAPSHOT_CACHE_PREFIX}_${kind}_${digest}`;
}

async function resolveExecutorRoot(explicitRoot?: string): Promise<string> {
  if (explicitRoot) {
    const canonical = await fs.promises.realpath(explicitRoot);
    const toolchains = path.join(canonical, "toolchains");
    await fs.promises.mkdir(toolchains, { recursive: true });
    return canonical;
  }
  const health = await executorClient.start();
  if (!health.ready) {
    throw new Error(health.diagnostics.join("; ") || "SECURE_RUNNER_UNAVAILABLE");
  }
  return fs.promises.realpath(health.executorRoot);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function cleanupOrphanedLocalSnapshotStaging(options: {
  executorRoot?: string;
  minimumAgeMs?: number;
  now?: number;
} = {}): Promise<string[]> {
  const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_ORPHAN_MINIMUM_AGE_MS;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
    throw new Error("Snapshot staging cleanup age is invalid.");
  }
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Snapshot staging cleanup time is invalid.");
  }

  const executorRoot = await resolveExecutorRoot(options.executorRoot);
  const toolchainsRoot = await fs.promises.realpath(path.join(executorRoot, "toolchains"));
  const removed: string[] = [];
  const entries = await fs.promises.readdir(toolchainsRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = STAGING_NAME_PATTERN.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || processIsAlive(pid)) continue;

    const candidate = path.join(toolchainsRoot, entry.name);
    if (path.dirname(path.resolve(candidate)) !== path.resolve(toolchainsRoot)) continue;
    const metadata = await fs.promises.lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    if (now - metadata.mtimeMs < minimumAgeMs) continue;
    await fs.promises.rm(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }
  return removed;
}

function readMarker(snapshotRoot: string): LocalSnapshotMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(snapshotRoot, SNAPSHOT_MARKER), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    const keys = Object.keys(marker).sort();
    if (keys.join("|") !== [
      "fileCount",
      "kind",
      "relativeExecutablePath",
      "schemaVersion",
      "snapshotDigest",
      "totalBytes",
    ].sort().join("|")) return null;
    if (
      marker.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || (marker.kind !== "cpp" && marker.kind !== "python")
      || typeof marker.snapshotDigest !== "string"
      || !SNAPSHOT_DIGEST_PATTERN.test(marker.snapshotDigest)
      || typeof marker.relativeExecutablePath !== "string"
      || !Number.isSafeInteger(marker.fileCount)
      || Number(marker.fileCount) < 0
      || !Number.isSafeInteger(marker.totalBytes)
      || Number(marker.totalBytes) < 0
    ) return null;
    return {
      schemaVersion: 1,
      kind: marker.kind,
      snapshotDigest: marker.snapshotDigest,
      relativeExecutablePath: safeRelativePath(marker.relativeExecutablePath),
      fileCount: Number(marker.fileCount),
      totalBytes: Number(marker.totalBytes),
    };
  } catch {
    return null;
  }
}

export async function createLocalToolchainSnapshot(options: {
  kind: ToolchainKind;
  sourceRoot: string;
  executablePath: string;
  executorRoot?: string;
  limits?: DirectoryTreeLimits;
}): Promise<LocalToolchainSnapshot> {
  const beforeCopy = await estimateDirectoryTree(options.sourceRoot, options.limits);
  const canonicalExecutable = await fs.promises.realpath(options.executablePath);
  if (!isDescendant(beforeCopy.canonicalRoot, canonicalExecutable)) {
    throw new Error("Snapshot executable is outside the selected toolchain root.");
  }
  if (!(await fs.promises.stat(canonicalExecutable)).isFile()) {
    throw new Error("Snapshot executable is not a regular file.");
  }
  const relativeExecutablePath = safeRelativePath(
    path.relative(beforeCopy.canonicalRoot, canonicalExecutable),
  );
  const executorRoot = await resolveExecutorRoot(options.executorRoot);
  await cleanupOrphanedLocalSnapshotStaging({ executorRoot });
  const toolchainsRoot = path.join(executorRoot, "toolchains");
  const staging = path.join(
    toolchainsRoot,
    `.local_${options.kind}_pending.${process.pid}.${crypto.randomUUID()}.staging`,
  );
  if (!isDescendant(toolchainsRoot, staging)) {
    throw new Error("Refusing to stage a snapshot outside the executor toolchain cache.");
  }
  try {
    await fs.promises.rm(staging, { recursive: true, force: true });
    const payloadRoot = path.join(staging, "payload");
    await fs.promises.mkdir(staging, { recursive: true });
    await fs.promises.cp(beforeCopy.canonicalRoot, payloadRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    const afterCopy = await estimateDirectoryTree(options.sourceRoot, options.limits);
    if (
      afterCopy.canonicalRoot !== beforeCopy.canonicalRoot
      || afterCopy.metadataDigest !== beforeCopy.metadataDigest
      || afterCopy.fileCount !== beforeCopy.fileCount
      || afterCopy.totalBytes !== beforeCopy.totalBytes
    ) {
      throw new Error("TOOLCHAIN_DRIFTED: snapshot source changed while it was copied.");
    }
    const copied = await inspectDirectoryTree(payloadRoot, options.limits);
    if (
      copied.fileCount !== beforeCopy.fileCount
      || copied.totalBytes !== beforeCopy.totalBytes
    ) {
      throw new Error("TOOLCHAIN_DRIFTED: snapshot source changed while it was copied.");
    }
    const copiedExecutable = path.join(payloadRoot, relativeExecutablePath);
    const canonicalCopiedExecutable = await fs.promises.realpath(copiedExecutable);
    if (
      !isDescendant(payloadRoot, canonicalCopiedExecutable)
      || !(await fs.promises.stat(canonicalCopiedExecutable)).isFile()
    ) {
      throw new Error("Snapshot copy does not contain the certified executable.");
    }
    const marker: LocalSnapshotMarker = {
      schemaVersion: 1,
      kind: options.kind,
      snapshotDigest: copied.treeDigest,
      relativeExecutablePath,
      fileCount: copied.fileCount,
      totalBytes: copied.totalBytes,
    };
    const snapshotRoot = path.join(
      toolchainsRoot,
      cacheName(options.kind, copied.treeDigest),
    );
    if (!isDescendant(toolchainsRoot, snapshotRoot)) {
      throw new Error("Refusing to create a snapshot outside the executor toolchain cache.");
    }
    const existing = readMarker(snapshotRoot);
    if (existing && canonicalMarker(existing) === canonicalMarker(marker)) {
      const verified = await verifyLocalToolchainSnapshot({
        kind: options.kind,
        snapshotDigest: copied.treeDigest,
        executorRoot,
        limits: options.limits,
      });
      if (verified.relativeExecutablePath === relativeExecutablePath) {
        return { ...verified, created: false };
      }
    }
    await fs.promises.writeFile(path.join(staging, SNAPSHOT_MARKER), canonicalMarker(marker), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o400,
    });
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    await fs.promises.rename(staging, snapshotRoot);
    const finalPayloadRoot = await fs.promises.realpath(path.join(snapshotRoot, "payload"));
    const finalExecutablePath = await fs.promises.realpath(
      path.join(finalPayloadRoot, relativeExecutablePath),
    );
    if (!isDescendant(finalPayloadRoot, finalExecutablePath)) {
      throw new Error("Snapshot executable escaped its payload root after installation.");
    }
    return {
      canonicalRoot: finalPayloadRoot,
      treeDigest: copied.treeDigest,
      fileCount: copied.fileCount,
      totalBytes: copied.totalBytes,
      kind: options.kind,
      root: snapshotRoot,
      payloadRoot: finalPayloadRoot,
      executablePath: finalExecutablePath,
      executableId: path.relative(executorRoot, finalExecutablePath).replaceAll("\\", "/"),
      relativeExecutablePath,
      created: true,
    };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

export async function verifyLocalToolchainSnapshot(options: {
  kind: ToolchainKind;
  snapshotDigest: string;
  executorRoot?: string;
  limits?: DirectoryTreeLimits;
}): Promise<LocalToolchainSnapshot> {
  const executorRoot = await resolveExecutorRoot(options.executorRoot);
  const toolchainsRoot = path.join(executorRoot, "toolchains");
  const root = path.join(toolchainsRoot, cacheName(options.kind, options.snapshotDigest));
  if (!isDescendant(toolchainsRoot, root)) throw new Error("Snapshot path escaped the cache root.");
  const marker = readMarker(root);
  if (
    !marker
    || marker.kind !== options.kind
    || marker.snapshotDigest !== options.snapshotDigest
  ) {
    throw new Error("CERTIFICATE_STALE: local toolchain snapshot marker is missing or invalid.");
  }
  const payloadRoot = path.join(root, "payload");
  const inspection = await inspectDirectoryTree(payloadRoot, options.limits);
  if (
    inspection.treeDigest !== marker.snapshotDigest
    || inspection.fileCount !== marker.fileCount
    || inspection.totalBytes !== marker.totalBytes
  ) {
    throw new Error("TOOLCHAIN_DRIFTED: local toolchain snapshot content changed.");
  }
  const executablePath = path.join(payloadRoot, marker.relativeExecutablePath);
  if (!isDescendant(payloadRoot, executablePath)) {
    throw new Error("CERTIFICATE_STALE: snapshot executable escaped its payload root.");
  }
  const canonicalExecutable = await fs.promises.realpath(executablePath);
  if (!isDescendant(payloadRoot, canonicalExecutable)) {
    throw new Error("CERTIFICATE_STALE: snapshot executable does not resolve inside its payload root.");
  }
  return {
    ...inspection,
    kind: options.kind,
    root,
    payloadRoot,
    executablePath: canonicalExecutable,
    executableId: path.relative(executorRoot, canonicalExecutable).replaceAll("\\", "/"),
    relativeExecutablePath: marker.relativeExecutablePath,
  };
}

export function findLocalToolchainSnapshot(options: {
  kind: ToolchainKind;
  snapshotDigest: string;
  relativeExecutablePath: string;
  executorRoot?: string;
}): Omit<LocalToolchainSnapshot, keyof DirectoryTreeInspection> | null {
  const rawExecutorRoot = options.executorRoot || executorClient.health.executorRoot;
  if (!rawExecutorRoot || !path.isAbsolute(rawExecutorRoot)) return null;
  try {
    const executorRoot = fs.realpathSync(rawExecutorRoot);
    const toolchainsRoot = path.join(executorRoot, "toolchains");
    const root = path.join(toolchainsRoot, cacheName(options.kind, options.snapshotDigest));
    if (!isDescendant(toolchainsRoot, root)) return null;
    const marker = readMarker(root);
    const relativeExecutablePath = safeRelativePath(options.relativeExecutablePath);
    if (
      !marker
      || marker.kind !== options.kind
      || marker.snapshotDigest !== options.snapshotDigest
      || marker.relativeExecutablePath !== relativeExecutablePath
    ) return null;
    const payloadRoot = path.join(root, "payload");
    const executablePath = path.join(payloadRoot, relativeExecutablePath);
    const canonicalPayload = fs.realpathSync(payloadRoot);
    const canonicalExecutable = fs.realpathSync(executablePath);
    if (
      !isDescendant(canonicalPayload, canonicalExecutable)
      || !fs.statSync(canonicalExecutable).isFile()
    ) return null;
    return {
      kind: options.kind,
      root,
      payloadRoot: canonicalPayload,
      executablePath: canonicalExecutable,
      executableId: path.relative(executorRoot, canonicalExecutable).replaceAll("\\", "/"),
      relativeExecutablePath,
    };
  } catch {
    return null;
  }
}

export async function removeLocalToolchainSnapshot(options: {
  kind: ToolchainKind;
  snapshotDigest: string;
  executorRoot?: string;
}): Promise<void> {
  const executorRoot = await resolveExecutorRoot(options.executorRoot);
  const toolchainsRoot = path.join(executorRoot, "toolchains");
  const root = path.join(toolchainsRoot, cacheName(options.kind, options.snapshotDigest));
  if (!isDescendant(toolchainsRoot, root)) {
    throw new Error("Refusing to remove a snapshot outside the executor cache.");
  }
  await fs.promises.rm(root, { recursive: true, force: true });
}
