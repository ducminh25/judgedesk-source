import fs from "node:fs";
import path from "node:path";

/** Machine-wide installer resources must be readable by users other than the builder. */
export function normalizeLinuxDistributionPermissions(root: string): void {
  visitPermissions(root, true);
}

export function validateLinuxDistributionPermissions(root: string): void {
  visitPermissions(root, false);
}

function visitPermissions(root: string, normalize: boolean): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Linux distribution resources must be regular files or directories: ${current}`);
    }
    const mode = metadata.isDirectory() || (metadata.mode & 0o111) !== 0 ? 0o755 : 0o644;
    if (normalize) fs.chmodSync(current, mode);
    else if ((metadata.mode & 0o7777) !== mode) {
      throw new Error(`Invalid Linux distribution resource permissions: ${current}`);
    }
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    }
  }
}
