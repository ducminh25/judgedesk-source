import path from "path";

export function mapWindowsPath(hostPath: string, mountPrefix: string): string {
  const normalizedInput = hostPath.replace(/\\/g, "/");
  const directMapping = mapDrivePath(normalizedInput, mountPrefix);
  if (directMapping) return directMapping;

  // Paths that are already valid inside WSL/Docker must stay POSIX paths.
  if (normalizedInput.startsWith("/")) {
    return path.posix.normalize(normalizedInput);
  }

  const resolved = path.resolve(hostPath).replace(/\\/g, "/");
  return mapDrivePath(resolved, mountPrefix) || resolved;
}

function mapDrivePath(hostPath: string, mountPrefix: string): string | null {
  const driveMatch = hostPath.match(/^([a-zA-Z]):\/(.*)$/);
  if (!driveMatch) return null;

  const drive = driveMatch[1].toLowerCase();
  const relativePath = path.posix
    .normalize(`/${driveMatch[2]}`)
    .replace(/^\/+/, "");
  const prefix = mountPrefix.replace(/\/+$/, "");
  return relativePath
    ? `${prefix}/${drive}/${relativePath}`
    : `${prefix}/${drive}`;
}
