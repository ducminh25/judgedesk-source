import fs from "fs";
import os from "os";
import { execFile, spawn } from "child_process";
import { Socket } from "node:net";
import { hostProcessEnvironment } from "../../shared/linux-host-environment.js";

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
  await launchWorkbookViewer(openCommand.command, openCommand.args);
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

export function launchWorkbookViewer(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true, stdio: ["ignore", "ignore", "pipe"],
      env: hostProcessEnvironment(), windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (child.stderr instanceof Socket) child.stderr.unref();
      if (error) reject(error);
      else resolve();
    };
    // This confirms only process handoff, not that a viewer window was drawn.
    const timer = setTimeout(() => finish(), 250);
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < 16_384) stderr += data.toString("utf8").slice(0, 16_384 - stderr.length);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      const error = code === 0 ? undefined : new Error(`Workbook viewer exited with ${code ?? signal}: ${stderr.trim()}`);
      if (settled && error) console.warn(error.message);
      finish(error);
    });
  });
}
