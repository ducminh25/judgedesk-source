import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSafeOsdComponent } from "./osd-parser.js";

/** Roots/ancestors must be writable only by the host, not by submitting users. */
export function ensureOsdDirectory(root: string, ...components: string[]): string {
  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("OSD requires a regular non-linked directory");
  }
  let directory = fs.realpathSync(root);
  for (const component of components) {
    if (!isSafeOsdComponent(component)) throw new Error("Unsafe OSD directory component");
    directory = path.join(directory, component);
    const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error("OSD directory cannot be a link or non-directory");
    }
    if (!entry) fs.mkdirSync(directory, { mode: 0o700 });
  }
  return directory;
}

export function writeOsdFile(root: string, directories: string[], name: string, content: string | Buffer | { sourcePath: string }): string {
  if (!isSafeOsdComponent(name)) throw new Error("Unsafe OSD file name");
  const directory = ensureOsdDirectory(root, ...directories);
  const target = path.join(directory, name);
  const previous = fs.lstatSync(target, { throwIfNoEntry: false });
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) {
    throw new Error("OSD output cannot replace a link or non-file");
  }
  const staging = path.join(directory, `.osd-${crypto.randomUUID()}.tmp`);
  try {
    if (typeof content === "object" && !Buffer.isBuffer(content)) {
      const source = fs.lstatSync(content.sourcePath);
      if (!source.isFile() || source.isSymbolicLink()) throw new Error("OSD copy requires a regular source");
      fs.copyFileSync(content.sourcePath, staging, fs.constants.COPYFILE_EXCL);
    }
    const descriptor = fs.openSync(staging, typeof content === "object" && !Buffer.isBuffer(content) ? "r+" : "wx", 0o600);
    try {
      if (typeof content === "string" || Buffer.isBuffer(content)) fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(staging, target);
    return target;
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}
