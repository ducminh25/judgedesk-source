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
import type {
  ExecutorLocalToolchainIdentity,
  ExecutorToolchainIdentity,
} from "../executor/protocol.js";
import type { ExecutorWorkspace } from "../executor/workspace.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

export interface IsolatedScratchLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainIdentity;
  localToolchain?: ExecutorLocalToolchainIdentity;
}

function tryExtractProjectJsonFromZip(buf: Buffer): string | null {
  try {
    let offset = 0;
    while (offset + 30 <= buf.length) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) {
        break;
      }
      const compression = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraFieldLen = buf.readUInt16LE(offset + 28);
      const fileNameStart = offset + 30;
      const fileName = buf.toString("utf8", fileNameStart, fileNameStart + fileNameLen);
      const dataStart = fileNameStart + fileNameLen + extraFieldLen;
      if (fileName === "project.json") {
        if (compressedSize === 0) {
          let end = buf.indexOf(Buffer.from([0x50, 0x4b]), dataStart);
          if (end === -1) end = buf.length;
          return buf.subarray(dataStart, end).toString("utf8");
        }
        const data = buf.subarray(dataStart, dataStart + compressedSize);
        if (compression === 0) {
          return data.toString("utf8");
        } else if (compression === 8) {
          return zlib.inflateRawSync(data).toString("utf8");
        }
      }
      offset = dataStart + compressedSize;
    }
  } catch {
    // Ignore extraction errors
  }
  return null;
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
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const executablePath = path.resolve(pinnedToolchain.executablePath);
  const rootPath = path.resolve(
    pinnedToolchain.packageRoot || path.dirname(executablePath),
  );
  const relativePath = path.relative(rootPath, executablePath).replaceAll("\\", "/");

  // Always stage the declared source file directly into the workspace to preserve byte identity
  workspace.stage(sourcePath, stagedName);

  const ext = path.extname(stagedName).toLowerCase();
  const fileBuf = fs.readFileSync(sourcePath);

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

  return {
    executableId: `local-toolchain/${relativePath}`,
    args: [
      stagedName,
    ],
    environment: {
      JUDGEDESK_SCRATCH_ISOLATED: "1",
      TURBO_MODE: "1",
      PATH: rootPath,
    },
    localToolchain: {
      rootPath,
      executableRelativePath: relativePath,
      isolation: "resource-only",
    },
  };
}
