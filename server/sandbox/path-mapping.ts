import path from "path";

export function mapWindowsPath(hostPath: string, mountPrefix: string): string {
  const resolved = path.resolve(hostPath).replace(/\\/g, "/");
  const driveMatch = resolved.match(/^([a-zA-Z]):\/(.*)$/);
  if (!driveMatch) return resolved;
  return `${mountPrefix}/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
}
