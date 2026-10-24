/** Linux packages with equal compiler versions can have different sysroots. */
export function managedCacheId(host: string, packageId: string, version: string, digest?: string): string {
  const legacy = packageId + "_" + version.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
  if (host !== "linux") return legacy;
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Linux managed cache requires a verified package digest.");
  return legacy.toLowerCase() + "_" + digest;
}
