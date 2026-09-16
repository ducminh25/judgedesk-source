import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppDataDir } from "./storage.js";

const POLICY_SCHEMA_VERSION = 1;
const MAX_POLICY_BYTES = 4 * 1024;

export interface LocalExecutionPolicyV1 {
  schemaVersion: 1;
  allowResourceOnlyLocalExecution: boolean;
}

export interface LocalExecutionPolicySnapshot
  extends LocalExecutionPolicyV1 {
  status: "default" | "ready" | "recovery";
  diagnostic?: "INVALID_POLICY_DOCUMENT" | "POLICY_READ_FAILED";
}

const SAFE_DEFAULT: LocalExecutionPolicyV1 = Object.freeze({
  schemaVersion: POLICY_SCHEMA_VERSION,
  allowResourceOnlyLocalExecution: true,
});

export function getLocalExecutionPolicyFilePath(): string {
  return path.join(getAppDataDir(), "toolchain-execution-policy-v1.json");
}

export function loadLocalExecutionPolicy(): LocalExecutionPolicySnapshot {
  const filePath = getLocalExecutionPolicyFilePath();
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
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
  return { ...policy, status: "ready" };
}

export function saveLocalExecutionPolicy(
  allowResourceOnlyLocalExecution: boolean,
): LocalExecutionPolicySnapshot {
  const policy: LocalExecutionPolicyV1 = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    allowResourceOnlyLocalExecution,
  };
  atomicWritePrivateFile(
    getLocalExecutionPolicyFilePath(),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  return { ...policy, status: "ready" };
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
