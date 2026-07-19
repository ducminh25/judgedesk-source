import os from "os";
import path from "path";
import sea from "node:sea";

export const IS_PRODUCTION =
  sea.isSea() ||
  !!(process as NodeJS.Process & { pkg?: unknown }).pkg ||
  process.env.NODE_ENV === "production";

export const APP_ROOT = IS_PRODUCTION
  ? path.dirname(process.execPath)
  : process.cwd();
export const RESOURCE_ROOT = process.env.THEMIS_RESOURCE_DIR || APP_ROOT;
export const TEMP_ROOT = path.join(os.tmpdir(), "judgedesk");
export const SERVER_PORT = Number.parseInt(process.env.PORT || "3000", 10);
