/**
 * Headless Scratch Execution Adapter for JudgeDesk.
 *
 * Implements automated headless judging for Scratch projects (.sb3, .sb2, .sb, project.json).
 *
 * I/O Contract:
 * - Standard Input: Handled via Scratch's `ask () and wait` blocks (line-by-line & tokenized).
 * - Standard Output: Emitted via Scratch's `say ()` (with newline) and `think ()` (without newline).
 * - Turbo Mode: Enabled by default for high-speed execution.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { ExecutorToolchainIdentity } from "../executor/protocol.js";
import { prepareManagedToolchainComponent } from "../executor/workspace.js";
import type { ExecutorWorkspace } from "../executor/workspace.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

export interface IsolatedScratchLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain: ExecutorToolchainIdentity;
}

const MAX_PROJECT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; ++bit) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function tryExtractProjectJsonFromZip(buf: Buffer): string | null {
  try {
    const searchStart = Math.max(0, buf.length - 22 - 0xffff);
    let endRecord = -1;
    for (let cursor = buf.length - 22; cursor >= searchStart; --cursor) {
      if (buf.readUInt32LE(cursor) === 0x06054b50
        && cursor + 22 + buf.readUInt16LE(cursor + 20) === buf.length) {
        endRecord = cursor;
        break;
      }
    }
    if (endRecord < 0
      || buf.readUInt16LE(endRecord + 4) !== 0
      || buf.readUInt16LE(endRecord + 6) !== 0) return null;

    const entryCount = buf.readUInt16LE(endRecord + 10);
    if (entryCount === 0 || entryCount !== buf.readUInt16LE(endRecord + 8)) return null;
    const directorySize = buf.readUInt32LE(endRecord + 12);
    const directoryStart = buf.readUInt32LE(endRecord + 16);
    if (directoryStart + directorySize !== endRecord) return null;

    let cursor = directoryStart;
    let projectJson: string | null = null;
    let totalUncompressed = 0;
    for (let entryIndex = 0; entryIndex < entryCount; ++entryIndex) {
      if (cursor + 46 > endRecord || buf.readUInt32LE(cursor) !== 0x02014b50) return null;
      const flags = buf.readUInt16LE(cursor + 8);
      const compression = buf.readUInt16LE(cursor + 10);
      const expectedCrc = buf.readUInt32LE(cursor + 16);
      const compressedSize = buf.readUInt32LE(cursor + 20);
      const uncompressedSize = buf.readUInt32LE(cursor + 24);
      const nameLength = buf.readUInt16LE(cursor + 28);
      const extraLength = buf.readUInt16LE(cursor + 30);
      const commentLength = buf.readUInt16LE(cursor + 32);
      const localOffset = buf.readUInt32LE(cursor + 42);
      const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
      if (nextCursor > endRecord || flags & 1 || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff || localOffset === 0xffffffff
        || compressedSize > MAX_ARCHIVE_ENTRY_BYTES
        || uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) return null;
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) return null;
      const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      if (localOffset + 30 > directoryStart || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localFlags = buf.readUInt16LE(localOffset + 6);
      const localCompression = buf.readUInt16LE(localOffset + 8);
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const localName = buf.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (localFlags !== flags || localCompression !== compression || localName !== name
        || dataStart + compressedSize > directoryStart) return null;
      if (!(flags & 8) && (buf.readUInt32LE(localOffset + 14) !== expectedCrc
        || buf.readUInt32LE(localOffset + 18) !== compressedSize
        || buf.readUInt32LE(localOffset + 22) !== uncompressedSize)) return null;
      if (flags & 8) {
        const descriptorStart = dataStart + compressedSize;
        const descriptorFields = descriptorStart + 4 <= directoryStart
          && buf.readUInt32LE(descriptorStart) === 0x08074b50
          ? descriptorStart + 4
          : descriptorStart;
        if (descriptorFields + 12 > directoryStart
          || buf.readUInt32LE(descriptorFields) !== expectedCrc
          || buf.readUInt32LE(descriptorFields + 4) !== compressedSize
          || buf.readUInt32LE(descriptorFields + 8) !== uncompressedSize) return null;
      }

      if (name === "project.json" && (projectJson !== null
        || uncompressedSize > MAX_PROJECT_JSON_BYTES)) return null;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      const contents = compression === 0
        ? compressed
        : compression === 8
          ? zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES })
          : null;
      if (!contents || contents.length !== uncompressedSize || crc32(contents) !== expectedCrc) return null;
      if (name === "project.json") {
        projectJson = contents.toString("utf8");
      }
      cursor = nextCursor;
    }
    return cursor === endRecord ? projectJson : null;
  } catch {
    return null;
  }
}

export async function prepareIsolatedScratchScript(
  workspace: ExecutorWorkspace,
  sourcePath: string,
  stagedName: string,
  pinnedToolchain: Readonly<ResolvedToolchain>,
): Promise<IsolatedScratchLaunch> {
  if (
    pinnedToolchain.kind !== "scratch"
    || !pinnedToolchain.ready
    || pinnedToolchain.source !== "managed"
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  stageValidatedScratchProject(workspace, sourcePath, stagedName);
  const runtime = await prepareManagedToolchainComponent(
    "scratch",
    pinnedToolchain,
    pinnedToolchain.packageComponentId,
    "submission-runtime",
  );
  if (!runtime.toolchain) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  return buildIsolatedScratchLaunch(stagedName, {
    executableId: runtime.executableId,
    executablePath: runtime.executablePath,
    root: runtime.root,
    toolchain: runtime.toolchain,
  });
}

export function stageValidatedScratchProject(
  workspace: ExecutorWorkspace,
  sourcePath: string,
  stagedName: string,
): string {
  // Always stage the declared source file directly into the workspace to preserve byte identity
  const stagedPath = workspace.stage(sourcePath, stagedName);

  const ext = path.extname(stagedName).toLowerCase();
  const fileBuf = fs.readFileSync(stagedPath);

  // Validate format and ensure malformed archives fail closed without synthetic fallback
  if (ext === ".sb3") {
    const extracted = tryExtractProjectJsonFromZip(fileBuf);
    if (!extracted) {
      throw new Error("SCRATCH_PROJECT_MALFORMED: Invalid .sb3 archive, missing or unreadable project.json");
    }
    try {
      const parsed = JSON.parse(extracted);
      if (!parsed || !Array.isArray(parsed.targets)) {
        throw new Error("SCRATCH_PROJECT_MALFORMED: Invalid Scratch 3.0 project schema, missing targets");
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("SCRATCH_PROJECT_MALFORMED")) throw e;
      throw new Error("SCRATCH_PROJECT_MALFORMED: Unparseable project.json in .sb3 archive");
    }
  } else if (ext === ".sb2") {
    const extracted = tryExtractProjectJsonFromZip(fileBuf);
    if (!extracted) {
      throw new Error("SCRATCH_PROJECT_MALFORMED: Invalid .sb2 archive, missing or unreadable project.json");
    }
    try {
      const parsed = JSON.parse(extracted);
      if (!parsed || (!parsed.objName && !parsed.children)) {
        throw new Error("SCRATCH_PROJECT_MALFORMED: Invalid Scratch 2.0 project schema");
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("SCRATCH_PROJECT_MALFORMED")) throw e;
      throw new Error("SCRATCH_PROJECT_MALFORMED: Unparseable project.json in .sb2 archive");
    }
  } else if (ext === ".json") {
    try {
      const parsed = JSON.parse(fileBuf.toString("utf8"));
      if (!parsed || (!Array.isArray(parsed.targets) && !parsed.objName)) {
        throw new Error("SCRATCH_PROJECT_MALFORMED: Invalid Scratch JSON project");
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("SCRATCH_PROJECT_MALFORMED")) throw e;
      throw new Error("SCRATCH_PROJECT_MALFORMED: Unparseable Scratch project.json");
    }
  }

  return stagedPath;
}

export function buildIsolatedScratchLaunch(
  stagedName: string,
  runtime: {
    executableId: string;
    executablePath: string;
    root: string;
    toolchain: ExecutorToolchainIdentity;
  },
): IsolatedScratchLaunch {
  return {
    executableId: runtime.executableId,
    args: [
      stagedName,
    ],
    environment: {
      JUDGEDESK_SCRATCH_ISOLATED: "1",
      TURBO_MODE: "1",
      PATH: path.dirname(runtime.executablePath),
    },
    toolchain: runtime.toolchain,
  };
}
