import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  TOOLCHAIN_CONTENT_INDEX_NAME, TOOLCHAIN_CONTENT_MAX_BYTES,
  TOOLCHAIN_CONTENT_MAX_FILES, TOOLCHAIN_CONTENT_MAX_FILE_BYTES,
  type ToolchainContentIndex,
} from "../../shared/toolchain-content-index.js";

export async function writeToolchainContentIndex(root: string): Promise<string> {
  const rootMetadata = fs.lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Toolchain index root must be a regular directory.");
  }
  const entries: ToolchainContentIndex["entries"] = [];
  const pending = [""];
  let totalBytes = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    for (const name of fs.readdirSync(path.join(root, relativeDirectory)).sort()) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relative === TOOLCHAIN_CONTENT_INDEX_NAME) continue;
      if (name.includes("\\") || /[\x00-\x1f]/.test(name)) {
        throw new Error(`Unsupported toolchain index path: ${relative}`);
      }
      const file = path.join(root, ...relative.split("/"));
      const metadata = fs.lstatSync(file);
      if (metadata.isSymbolicLink()) throw new Error(`Toolchain index rejects symbolic link: ${relative}`);
      if (metadata.isDirectory()) {
        entries.push({ path: relative, kind: "directory" });
        pending.push(relative);
      } else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (metadata.size > TOOLCHAIN_CONTENT_MAX_FILE_BYTES || totalBytes > TOOLCHAIN_CONTENT_MAX_BYTES) {
          throw new Error("Toolchain content exceeds the byte limit.");
        }
        const hash = crypto.createHash("sha256");
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        entries.push({ path: relative, kind: "file", sizeBytes: metadata.size,
          executable: Boolean(metadata.mode & 0o111), sha256: hash.digest("hex") });
      } else {
        throw new Error(`Toolchain index rejects special file: ${relative}`);
      }
      if (entries.length > TOOLCHAIN_CONTENT_MAX_FILES) throw new Error("Toolchain index exceeds the entry limit.");
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bytes = `${JSON.stringify({ schemaVersion: 1, entries } satisfies ToolchainContentIndex)}\n`;
  const index = path.join(root, TOOLCHAIN_CONTENT_INDEX_NAME);
  // Output is inside a private staging tree; never follow an existing link.
  const existing = fs.lstatSync(index, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Invalid content index destination.");
  const temporary = `${index}.stage-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, index);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
