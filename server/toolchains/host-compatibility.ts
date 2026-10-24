import { execFileSync } from "node:child_process";
import os from "node:os";

let cachedHostVersion: string | undefined;

export function getHostProductVersion(
  platform: NodeJS.Platform = os.platform(),
): string {
  if (platform === os.platform() && cachedHostVersion !== undefined) {
    return cachedHostVersion;
  }
  let version = "";
  if (platform === "darwin") {
    try {
      version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      version = "";
    }
  } else if (platform === "win32") {
    version = os.release().trim();
  } else if (platform === "linux") {
    const report = process.report.getReport();
    if ("header" in report && typeof report.header === "object" && report.header !== null
      && "glibcVersionRuntime" in report.header && typeof report.header.glibcVersionRuntime === "string") {
      version = report.header.glibcVersionRuntime.trim();
    }
  }
  if (platform === os.platform()) cachedHostVersion = version;
  return version;
}

/** Linux minimumOs names the build baseline, not a comparable distro version. */
export function isManagedHostSupported(
  platform: NodeJS.Platform,
  minimumVersion: string,
  hostVersion: string = getHostProductVersion(platform),
): boolean {
  if (platform === "linux") {
    // Match the whole-payload ELF gate; unknown future baselines fail closed.
    return minimumVersion === "22.04" && isMinimumOsSupported("2.35", hostVersion);
  }
  return isMinimumOsSupported(minimumVersion, hostVersion);
}

export function isMinimumOsSupported(
  minimumVersion: string,
  hostVersion: string = getHostProductVersion(),
): boolean {
  const minimum = numericVersion(minimumVersion);
  const host = numericVersion(hostVersion);
  if (!minimum || !host) return false;
  const length = Math.max(minimum.length, host.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (host[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function numericVersion(value: string): number[] | null {
  if (!/^[0-9]+(?:\.[0-9]+)*$/.test(value)) return null;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0)
    ? parts
    : null;
}

export function resetHostProductVersionCacheForTests(): void {
  cachedHostVersion = undefined;
}
