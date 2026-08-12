import fs from "fs";
import os from "os";
import { execFile, spawn } from "child_process";

const EXCEL_APP_PATH_KEYS = [
  String.raw`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe`,
  String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe`,
  String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\excel.exe`,
];

let cachedExcelExecutable: Promise<string | null> | undefined;

export type WorkbookOpenMode = "excel-unsaved" | "system-open";

export interface WorkbookOpenCommand {
  command: string;
  args: string[];
  mode: WorkbookOpenMode;
}

export async function openScoreWorkbook(workbookPath: string): Promise<WorkbookOpenMode> {
  const platform = os.platform();
  const excelExecutable = platform === "win32"
    ? await findWindowsExcelExecutable()
    : null;
  const openCommand = createWorkbookOpenCommand(platform, workbookPath, excelExecutable);
  spawnDetached(openCommand.command, openCommand.args);
  return openCommand.mode;
}

export function createWorkbookOpenCommand(
  platform: NodeJS.Platform,
  workbookPath: string,
  excelExecutable: string | null,
): WorkbookOpenCommand {
  if (platform === "win32" && excelExecutable) {
    // Excel's documented /t switch opens an existing .xlsx as the template
    // for a new, unsaved workbook. The source remains a normal .xlsx file.
    return {
      command: excelExecutable,
      args: ["/t", workbookPath],
      mode: "excel-unsaved",
    };
  }
  if (platform === "win32") {
    return { command: "explorer.exe", args: [workbookPath], mode: "system-open" };
  }
  if (platform === "darwin") {
    return { command: "open", args: [workbookPath], mode: "system-open" };
  }
  return { command: "xdg-open", args: [workbookPath], mode: "system-open" };
}

export function parseWindowsRegistryDefaultValue(output: string): string | null {
  // `reg query /ve` returns only the unnamed default value. Match the value
  // type instead of its localized display label.
  const match = output.match(/^\s*.*?\bREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im);
  return match?.[1]?.trim() || null;
}

async function findWindowsExcelExecutable(): Promise<string | null> {
  cachedExcelExecutable ??= resolveWindowsExcelExecutable();
  return cachedExcelExecutable;
}

async function resolveWindowsExcelExecutable(): Promise<string | null> {
  const candidates = await Promise.all(EXCEL_APP_PATH_KEYS.map(queryRegistryDefaultValue));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking when a stale Office registration points to a removed file.
    }
  }
  return null;
}

function queryRegistryDefaultValue(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", key, "/ve"],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => resolve(error ? null : parseWindowsRegistryDefaultValue(stdout)),
    );
  });
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    console.warn(`Could not hand the score workbook to ${command}:`, error);
  });
  child.unref();
}
