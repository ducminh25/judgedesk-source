import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureOsdDirectory } from "./osd-files.js";
import { isSafeOsdComponent } from "./osd-parser.js";

export interface OsdSource {
  readonly filePath: string;
  readonly sha256: string;
  assertIntegrity(): void;
  dispose(): void;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContent(left: fs.Stats, right: fs.Stats): boolean {
  return sameFile(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Atomically claim before waiting, so a later web write gets a different file. */
export async function claimOsdSource(
  inbox: string, fileName: string, stagedName: string,
  options: { debounceMs: number; maxRetries: number; isActive(): boolean },
): Promise<OsdSource | undefined> {
  if (!isSafeOsdComponent(fileName) || !isSafeOsdComponent(stagedName)) throw new Error("OSD_UNSAFE_SOURCE_NAME");
  const root = ensureOsdDirectory(inbox);
  const input = path.join(root, fileName);
  const inputMetadata = fs.lstatSync(input);
  if (!inputMetadata.isFile() || inputMetadata.isSymbolicLink() || inputMetadata.nlink !== 1) {
    throw new Error("OSD_SOURCE_LINKED_OR_NOT_REGULAR");
  }
  const owned = fs.mkdtempSync(path.join(root, ".judgedesk-osd-"));
  fs.chmodSync(owned, 0o700);
  const owner = fs.lstatSync(owned);
  const incoming = path.join(owned, ".incoming");
  const staging = path.join(owned, ".snapshot");
  const filePath = path.join(owned, stagedName);
  let descriptor: number | undefined;
  let claimed = false;
  let admitted = false;
  try {
    fs.renameSync(input, incoming);
    claimed = true;
    const metadata = fs.lstatSync(incoming);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !sameFile(metadata, inputMetadata)) {
      throw new Error("OSD_SOURCE_CHANGED_DURING_CLAIM");
    }
    descriptor = fs.openSync(incoming, fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW));
    if (!sameFile(metadata, fs.fstatSync(descriptor))) throw new Error("OSD_SOURCE_CHANGED_DURING_OPEN");
    for (let attempt = 0; attempt < options.maxRetries; ++attempt) {
      if (!options.isActive()) return undefined;
      const before = fs.fstatSync(descriptor);
      await new Promise(resolve => setTimeout(resolve, options.debounceMs));
      if (!options.isActive()) return undefined;
      if (!sameContent(before, fs.fstatSync(descriptor))) continue;
      const output = fs.openSync(staging, "wx", 0o600);
      const digest = crypto.createHash("sha256");
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < before.size) {
          const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
          if (read === 0) throw new Error("OSD_SOURCE_NOT_STABLE");
          const bytes = buffer.subarray(0, read);
          fs.writeFileSync(output, bytes);
          digest.update(bytes);
          position += read;
        }
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      if (!sameContent(before, fs.fstatSync(descriptor))) {
        fs.unlinkSync(staging);
        continue;
      }
      fs.renameSync(staging, filePath);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.unlinkSync(incoming);
      const fingerprint = digest.digest("hex");
      const snapshot = fs.lstatSync(filePath);
      admitted = true;
      let disposed = false;
      const assertOwned = (): void => {
        const current = fs.lstatSync(owned);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, owner)) {
          throw new Error("OSD_SOURCE_OWNERSHIP_LOST");
        }
      };
      return {
        filePath, sha256: fingerprint,
        assertIntegrity() {
          assertOwned();
          const current = fs.lstatSync(filePath);
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || !sameContent(current, snapshot)) throw new Error("OSD_SOURCE_INTEGRITY_MISMATCH");
          const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW));
          try {
            const before = fs.fstatSync(fd);
            const hash = crypto.createHash("sha256");
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let position = 0;
            while (position < before.size) {
              const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
              if (!read) throw new Error("OSD_SOURCE_INTEGRITY_MISMATCH");
              hash.update(buffer.subarray(0, read));
              position += read;
            }
            if (!sameContent(before, snapshot) || !sameContent(before, fs.fstatSync(fd)) || hash.digest("hex") !== fingerprint) {
              throw new Error("OSD_SOURCE_INTEGRITY_MISMATCH");
            }
          } finally {
            fs.closeSync(fd);
          }
        },
        dispose() {
          if (disposed) return;
          assertOwned();
          const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
          if (current && (!current.isFile() || current.isSymbolicLink() || !sameFile(current, snapshot))) {
            throw new Error("OSD_SOURCE_OWNERSHIP_LOST");
          }
          if (current) fs.unlinkSync(filePath);
          fs.rmdirSync(owned); // Empty owned leaf only; never recursive cleanup.
          disposed = true;
        },
      };
    }
    throw new Error("OSD_SOURCE_NOT_STABLE");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!admitted) {
      const current = fs.lstatSync(owned);
      if (!sameFile(current, owner) || current.isSymbolicLink()) throw new Error("OSD_SOURCE_OWNERSHIP_LOST");
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
      if (!fs.existsSync(incoming) && fs.existsSync(filePath)) fs.renameSync(filePath, incoming);
      if (claimed && fs.existsSync(incoming)) {
        try {
          fs.linkSync(incoming, input); // Exclusive publication: do not overwrite a newer submission.
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const rejected = ensureOsdDirectory(root, "Rejected");
          fs.renameSync(incoming, path.join(rejected, `${crypto.randomUUID()}.source`));
        }
        if (fs.existsSync(incoming)) fs.unlinkSync(incoming);
      }
      fs.rmdirSync(owned);
    }
  }
}
