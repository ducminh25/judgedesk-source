import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import type { DistributionLockV1 } from "../server/toolchains/distribution-builder.js";
import { listCurrentReleaseManagedPackageIds } from "../server/toolchains/release-scope.js";
import { validateLinuxDistributionPermissions } from "../server/toolchains/distribution-permissions.js";

const trustedCatalog = JSON.parse(fs.readFileSync(
  new URL("../shared/linux-full-package-trust.json", import.meta.url), "utf8",
)) as DistributionLockV1;

/** Validate metadata before building; the ELF gate verifies all payload bytes. */
export function validateLinuxFullResources(root: string, trusted = trustedCatalog): {
  packageCount: number; toolchainInstalledSizeBytes: number;
} {
  const required = [...listCurrentReleaseManagedPackageIds("linux", "x64")].sort();
  if (required.length === 0 || trusted.distribution !== "full" || trusted.platform !== "linux"
      || trusted.arch !== "x64" || !isDeepStrictEqual(trusted.packages.map((p) => p.id).sort(), required)) {
    throw new Error("Incomplete Linux Full trusted catalog package set.");
  }
  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Full resource root must be a regular directory.");
  if (process.platform === "linux") validateLinuxDistributionPermissions(root);
  const lock: unknown = JSON.parse(fs.readFileSync(path.join(root, "judgedesk-distribution-lock.json"), "utf8"));
  if (!isDeepStrictEqual(lock, trusted)) throw new Error("Linux Full lock differs from the independently trusted catalog.");
  const distribution: unknown = JSON.parse(fs.readFileSync(path.join(root, "judgedesk-distribution.json"), "utf8"));
  if (!isDeepStrictEqual(distribution, { schemaVersion: 1, distribution: "full" })) {
    throw new Error("Linux Full distribution identity is invalid.");
  }
  const manifestPath = path.join(root, "toolchains-manifest.json");
  const manifest = fs.lstatSync(manifestPath);
  if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.size > 4 * 1024 * 1024
      || crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex") !== trusted.manifestSha256) {
    throw new Error("Linux Full manifest does not match the trusted catalog.");
  }
  const directories = fs.readdirSync(path.join(root, "toolchains"), { withFileTypes: true });
  if (!isDeepStrictEqual(directories.map((d) => d.name).sort(), required)
      || directories.some((d) => !d.isDirectory() || d.isSymbolicLink())) {
    throw new Error("Linux Full resource package set is incomplete or contains additional entries.");
  }
  for (const pin of trusted.packages) {
    const index = path.join(root, "toolchains", pin.id, ".judgedesk-content.json");
    const metadata = fs.lstatSync(index);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 * 1024
        || !pin.contentIndexSha256
        || crypto.createHash("sha256").update(fs.readFileSync(index)).digest("hex") !== pin.contentIndexSha256) {
      throw new Error(`Linux Full content index failed verification: ${pin.id}`);
    }
  }
  return { packageCount: trusted.packages.length,
    toolchainInstalledSizeBytes: trusted.packages.reduce((sum, p) => sum + p.installedSizeBytes, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(validateLinuxFullResources(path.resolve(process.argv[2] || "build/distribution-resources"))));
}
