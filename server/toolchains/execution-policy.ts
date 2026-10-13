import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LocalExecutionPolicySnapshot,
  LocalExecutionPolicyV1,
} from "../../shared/contracts.js";
import { getAppDataDir } from "./storage.js";

const POLICY_SCHEMA_VERSION = 1;
const MAX_POLICY_BYTES = 4 * 1024;

const SAFE_DEFAULT: LocalExecutionPolicyV1 = Object.freeze({
  schemaVersion: POLICY_SCHEMA_VERSION,
  allowResourceOnlyLocalExecution: false,
});

export function getLocalExecutionPolicyFilePath(): string {
  return path.join(getAppDataDir(), "toolchain-execution-policy-v1.json");
}

export function loadLocalExecutionPolicy(
  filePath = getLocalExecutionPolicyFilePath(),
): LocalExecutionPolicySnapshot {
  let bytes: Buffer;
  try {
    bytes = readPolicyBytes(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...SAFE_DEFAULT, status: "default" };
    }
    return {
      ...SAFE_DEFAULT,
      status: "recovery",
      diagnostic: "POLICY_READ_FAILED",
    };
  }

  const policy = decodePolicy(bytes);
  if (!policy) {
    return {
      ...SAFE_DEFAULT,
      status: "recovery",
      diagnostic: "INVALID_POLICY_DOCUMENT",
    };
  }
  if (policy.allowResourceOnlyLocalExecution) {
    return {
      ...SAFE_DEFAULT,
      status: "recovery",
      diagnostic: "RESOURCE_ONLY_LOCAL_EXECUTION_DISABLED",
    };
  }
  return { ...SAFE_DEFAULT, status: "ready" };
}

export function saveLocalExecutionPolicy(
  allowResourceOnlyLocalExecution: boolean,
  filePath = getLocalExecutionPolicyFilePath(),
): LocalExecutionPolicySnapshot {
  if (allowResourceOnlyLocalExecution !== false) {
    throw new Error("Resource-only local execution is disabled.");
  }
  const policy = SAFE_DEFAULT;
  atomicWritePrivateFile(
    filePath,
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  return { ...policy, status: "ready" };
}

function readPolicyBytes(filePath: string): Buffer {
  // POSIX FIFO/device entries must not block before the regular-file check.
  // Windows does not expose O_NONBLOCK; it still uses a read-only descriptor.
  const descriptor = fs.openSync(filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Execution policy is not a regular file.");
    }
    // Read one extra byte to reject oversized files, including growth after
    // fstat. Never allocate from an untrusted size or read the whole document.
    const bytes = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(descriptor, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(descriptor);
  }
}

function decodePolicy(bytes: Buffer): LocalExecutionPolicyV1 | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_POLICY_BYTES) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2
      || record.schemaVersion !== POLICY_SCHEMA_VERSION
      || typeof record.allowResourceOnlyLocalExecution !== "boolean"
    ) {
      return null;
    }
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      allowResourceOnlyLocalExecution:
        record.allowResourceOnlyLocalExecution,
    };
  } catch {
    return null;
  }
}

function atomicWritePrivateFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is unsupported by some Windows filesystems. The file
    // itself was already flushed before the atomic rename.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
