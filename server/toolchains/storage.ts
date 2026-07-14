import fs from "fs";
import os from "os";
import path from "path";

export interface ToolchainPreferences {
  customCppPath?: string;
  customPythonPath?: string;
  preferredSourceCpp?: "managed" | "custom" | "system";
  preferredSourcePython?: "managed" | "custom" | "system";
  installedToolchains?: string[]; // list of descriptor ids
}

export function getAppDataDir(): string {
  if (process.env.THEMIS_APP_DATA_DIR) {
    return process.env.THEMIS_APP_DATA_DIR;
  }
  // Fallbacks for testing or running server independently
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "ThemisV2",
    );
  } else if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ThemisV2",
    );
  }
  return path.join(os.homedir(), ".themisv2-dev");
}

export function getToolchainsDir(): string {
  const dir = path.join(getAppDataDir(), "toolchains");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getPreferencesFilePath(): string {
  const dir = getAppDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "toolchains.json");
}

export function loadPreferences(): ToolchainPreferences {
  const filePath = getPreferencesFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("[Storage] Failed to read toolchain preferences:", error);
  }
  return {
    preferredSourceCpp: "system",
    preferredSourcePython: "system",
    installedToolchains: [],
  };
}

export function savePreferences(prefs: ToolchainPreferences): void {
  const filePath = getPreferencesFilePath();
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(prefs, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    console.error("[Storage] Failed to save toolchain preferences:", error);
    throw error;
  }
}
