import os from "os";
import path from "path";
import sea from "node:sea";

/**
 * Tauri returns resource paths with Windows' extended-length prefix. Node's
 * path helpers do not handle every `\\?\C:\...` combination consistently
 * (notably when realpath and relative checks are mixed), so convert only the
 * two filesystem namespaces that have an equivalent regular Win32 spelling.
 * Other device namespaces remain untouched and therefore continue to fail
 * closed at their consumers.
 */
export function normalizeWindowsVerbatimPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || !value.startsWith("\\\\?\\")) return value;

  const remainder = value.slice(4);
  if (/^[a-z]:\\/i.test(remainder)) return remainder;

  if (remainder.toLowerCase().startsWith("unc\\")) {
    const uncPath = remainder.slice(4);
    if (/^[^\\]+\\[^\\]+(?:\\.*)?$/.test(uncPath)) {
      return `\\\\${uncPath}`;
    }
  }
  return value;
}

export const IS_PRODUCTION =
  sea.isSea() ||
  !!(process as NodeJS.Process & { pkg?: unknown }).pkg ||
  process.env.NODE_ENV === "production";

export const APP_ROOT = normalizeWindowsVerbatimPath(
  IS_PRODUCTION
    ? path.dirname(process.execPath)
    : process.cwd(),
);
export const RESOURCE_ROOT = normalizeWindowsVerbatimPath(
  process.env.THEMIS_RESOURCE_DIR || APP_ROOT,
);
export const TEMP_ROOT = path.join(os.tmpdir(), "judgedesk");
export const SERVER_PORT = Number.parseInt(process.env.PORT || "3000", 10);
