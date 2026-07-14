import os from "os";
import { execFileSync } from "child_process";

export const WINDOWS_PICKER_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select Folder'
$dialog.ShowNewFolderButton = $true
if ($env:THEMIS_DEFAULT_PATH -and (Test-Path $env:THEMIS_DEFAULT_PATH -PathType Container)) {
    $dialog.SelectedPath = $env:THEMIS_DEFAULT_PATH
}
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}`;

export function selectDirectory(defaultPath?: string): string | null {
  if (os.platform() === "win32") {
    const env = { ...process.env };
    if (defaultPath) {
      env.THEMIS_DEFAULT_PATH = defaultPath;
    }
    const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", WINDOWS_PICKER_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      env
    }).trim();
    return output || null;
  }
  if (os.platform() === "darwin") {
    const args = ["-e", "POSIX path of (choose folder with prompt \"Select Folder\")"];
    if (defaultPath) {
      // NOTE: For osascript we should not interpolate, we pass it via args if possible, but AppleScript args to `choose folder default location` is tricky.
      // Actually, passing default location via command line argument to osascript:
      const script = `
        on run argv
          if (count of argv) > 0 then
            set defPath to POSIX file (item 1 of argv) as alias
            return POSIX path of (choose folder with prompt "Select Folder" default location defPath)
          else
            return POSIX path of (choose folder with prompt "Select Folder")
          end if
        end run
      `;
      const out = execFileSync("osascript", ["-e", script, defaultPath], { encoding: "utf8" }).trim();
      return out || null;
    }
    return execFileSync("osascript", ["-e", "POSIX path of (choose folder with prompt \"Select Folder\")"], { encoding: "utf8" }).trim();
  }
  if (os.platform() === "linux") {
    const args = ["--file-selection", "--directory", "--title=Select Folder"];
    if (defaultPath) {
      args.push(`--filename=${defaultPath}`);
    }
    try {
      const out = execFileSync("zenity", args, { encoding: "utf8" }).trim();
      return out || null;
    } catch (e: any) {
      // zenity returns non-zero exit code on cancel
      if (e.status === 1) return null;
      throw e;
    }
  }
  throw new Error(`Directory picker is not supported on ${os.platform()}.`);
}
