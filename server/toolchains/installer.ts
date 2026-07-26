import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { once } from "events";
import { purgeCachedManagedToolchain } from "../executor/workspace.js";
import { TOOLCHAIN_CATALOG } from "./manifest.js";
import { InstallProgress, ToolchainDescriptor } from "./types.js";
import {
  getToolchainsDir,
  loadPreferences,
  savePreferences,
} from "./storage.js";

export const installProgressMap = new Map<string, InstallProgress>();
const abortControllers = new Map<string, AbortController>();

export function getInstallProgress(id: string): InstallProgress | undefined {
  return installProgressMap.get(id);
}

export function cancelInstallation(id: string): void {
  const controller = abortControllers.get(id);
  if (!controller) return;

  controller.abort();
  const progress = installProgressMap.get(id);
  if (progress) {
    progress.status = "failed";
    progress.error = "Installation cancelled by user.";
  }
}

async function verifyChecksum(
  filePath: string,
  expectedSha256: string,
): Promise<boolean> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex").toLowerCase() === expectedSha256.toLowerCase();
}

async function downloadFile(
  url: string,
  destPath: string,
  expectedBytes: number,
  onProgress: (bytesReceived: number, totalBytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    headers: { Accept: "application/octet-stream" },
    redirect: "follow",
    signal,
  });
  if (!response.ok)
    throw new Error(`Failed to download package (${response.status}).`);
  if (!response.body)
    throw new Error("Toolchain download returned an empty response.");

  const totalBytes = Number.parseInt(
    response.headers.get("content-length") || "0",
    10,
  );
  if (totalBytes > 0 && totalBytes !== expectedBytes) {
    throw new Error(
      `Toolchain package size mismatch: expected ${expectedBytes} bytes but the server announced ${totalBytes}.`,
    );
  }
  const file = fs.createWriteStream(destPath, { flags: "wx" });
  let bytesReceived = 0;

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new Error("aborted");
      const buffer = Buffer.from(value);
      bytesReceived += buffer.length;
      if (bytesReceived > expectedBytes) {
        throw new Error("Toolchain download exceeded the signed package size.");
      }
      if (!file.write(buffer)) await once(file, "drain");
      onProgress(bytesReceived, totalBytes);
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      file.once("error", onError);
      file.end(() => {
        file.off("error", onError);
        resolve();
      });
    });
    if (bytesReceived !== expectedBytes) {
      throw new Error(
        `Toolchain package size mismatch: expected ${expectedBytes} bytes but received ${bytesReceived}.`,
      );
    }
  } catch (error) {
    file.destroy();
    try {
      fs.rmSync(destPath, { force: true });
    } catch {}
    if (signal.aborted) throw new Error("aborted");
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function validateArchiveEntries(entries: string[], destination: string): void {
  const root = path.resolve(destination);
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (!normalized || normalized === ".") continue;
    if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) {
      throw new Error(`Archive contains an absolute path: ${entry}`);
    }
    if (normalized.split("/").includes("..")) {
      throw new Error(
        `Archive contains a parent-directory traversal: ${entry}`,
      );
    }
    if (!isInside(root, path.resolve(root, normalized))) {
      throw new Error(
        `Archive entry escapes the installation directory: ${entry}`,
      );
    }
  }
}

export function validateExtractedLinks(root: string): void {
  const resolvedRoot = path.resolve(root);
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  validateExtractedLinksRecursive(resolvedRoot, canonicalRoot, resolvedRoot);
}

function validateExtractedLinksRecursive(
  displayRoot: string,
  canonicalRoot: string,
  current: string,
): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(entryPath);
      } catch {
        throw new Error(
          `Archive contains a broken symbolic link: ${path.relative(displayRoot, entryPath)}`,
        );
      }
      if (!isInside(canonicalRoot, target)) {
        throw new Error(
          `Archive symbolic link escapes the installation directory: ${path.relative(displayRoot, entryPath)}`,
        );
      }
    } else if (entry.isDirectory()) {
      validateExtractedLinksRecursive(displayRoot, canonicalRoot, entryPath);
    }
  }
}

function listWindowsZip(archivePath: string): string[] {
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [System.IO.Compression.ZipFile]::OpenRead($env:ZIP_PATH)",
    "try { @($zip.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $zip.Dispose() }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, ZIP_PATH: archivePath },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "Unable to inspect ZIP package.");
  const parsed = JSON.parse(result.stdout.trim() || "[]") as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function extractWindowsZip(archivePath: string, destination: string): void {
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:ZIP_PATH, $env:DEST_DIR)",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, ZIP_PATH: archivePath, DEST_DIR: destination },
      encoding: "utf8",
      timeout: 5 * 60_000,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "PowerShell ZIP extraction failed.");
}

function listUnixArchive(archivePath: string, format: string): string[] {
  const command = format === "zip" ? "unzip" : "tar";
  const args = format === "zip" ? ["-Z1", archivePath] : ["-tf", archivePath];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `Unable to inspect ${format} package.`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function extractArchive(
  archivePath: string,
  destination: string,
  format: string,
): void {
  const absoluteDestination = path.resolve(destination);
  fs.mkdirSync(absoluteDestination, { recursive: true });

  if (os.platform() === "win32") {
    if (format !== "zip")
      throw new Error(`Unsupported archive format '${format}' on Windows.`);
    validateArchiveEntries(listWindowsZip(archivePath), absoluteDestination);
    extractWindowsZip(archivePath, absoluteDestination);
  } else {
    validateArchiveEntries(
      listUnixArchive(archivePath, format),
      absoluteDestination,
    );
    const command = format === "zip" ? "unzip" : "tar";
    const args =
      format === "zip"
        ? ["-q", archivePath, "-d", absoluteDestination]
        : ["-xf", archivePath, "-C", absoluteDestination, "--no-same-owner"];
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 5 * 60_000,
    });
    if (result.status !== 0)
      throw new Error(result.stderr || `${command} extraction failed.`);
    validateExtractedLinks(absoluteDestination);
  }
}

function verifyExecutable(executablePath: string): void {
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error(
      `Invalid package: executable '${executablePath}' was not found.`,
    );
  }
  if (os.platform() !== "win32") {
    fs.chmodSync(executablePath, fs.statSync(executablePath).mode | 0o700);
  }
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0 || !(result.stdout || result.stderr).trim()) {
    throw new Error(
      "Installed compiler/runtime did not pass its executable verification.",
    );
  }
}

export async function installToolchain(
  descriptor: ToolchainDescriptor,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(descriptor.sha256))
    throw new Error("Toolchain package has no valid SHA-256 digest.");

  const progress: InstallProgress = {
    id: descriptor.id,
    status: "downloading",
    percent: 0,
    bytesReceived: 0,
    totalBytes: descriptor.sizeBytes,
  };
  installProgressMap.set(descriptor.id, progress);

  const controller = new AbortController();
  abortControllers.set(descriptor.id, controller);

  const toolchainsDir = getToolchainsDir();
  const operationId = `${process.pid}-${crypto.randomUUID()}`;
  const tempDownloadPath = path.join(
    toolchainsDir,
    `download-${descriptor.id}-${operationId}.tmp`,
  );
  const tempExtractDir = path.join(
    toolchainsDir,
    `extract-${descriptor.id}-${operationId}.tmp`,
  );
  const finalInstallDir = path.join(toolchainsDir, descriptor.id);
  const backupInstallDir = path.join(
    toolchainsDir,
    `backup-${descriptor.id}-${operationId}.tmp`,
  );
  let previousInstallBackedUp = false;
  let newInstallCommitted = false;

  try {
    await downloadFile(
      descriptor.downloadUrl,
      tempDownloadPath,
      descriptor.sizeBytes,
      (bytes, total) => {
        progress.bytesReceived = bytes;
        progress.totalBytes = total || descriptor.sizeBytes;
        progress.percent = progress.totalBytes
          ? Math.min(100, Math.round((bytes / progress.totalBytes) * 100))
          : 0;
      },
      controller.signal,
    );

    progress.status = "verifying";
    progress.percent = 100;
    if (!(await verifyChecksum(tempDownloadPath, descriptor.sha256))) {
      throw new Error(
        "SHA-256 checksum verification failed. The downloaded package was rejected.",
      );
    }

    progress.status = "extracting";
    extractArchive(tempDownloadPath, tempExtractDir, descriptor.archiveFormat);
    verifyExecutable(
      path.join(tempExtractDir, descriptor.executableRelativePath),
    );

    if (fs.existsSync(finalInstallDir)) {
      fs.renameSync(finalInstallDir, backupInstallDir);
      previousInstallBackedUp = true;
    }
    fs.renameSync(tempExtractDir, finalInstallDir);
    newInstallCommitted = true;

    const prefs = loadPreferences();
    prefs.installedToolchains ||= [];
    if (!prefs.installedToolchains.includes(descriptor.id))
      prefs.installedToolchains.push(descriptor.id);
    if (descriptor.kind === "cpp") prefs.preferredSourceCpp = "managed";
    else prefs.preferredSourcePython = "managed";
    savePreferences(prefs);

    if (previousInstallBackedUp) {
      fs.rmSync(backupInstallDir, { recursive: true, force: true });
      previousInstallBackedUp = false;
    }
    progress.status = "success";
    progress.percent = 100;
  } catch (error: any) {
    if (newInstallCommitted && fs.existsSync(finalInstallDir)) {
      fs.rmSync(finalInstallDir, { recursive: true, force: true });
    }
    if (previousInstallBackedUp && fs.existsSync(backupInstallDir)) {
      fs.renameSync(backupInstallDir, finalInstallDir);
      previousInstallBackedUp = false;
    }

    progress.status = "failed";
    progress.error = controller.signal.aborted
      ? "Installation cancelled by user."
      : error.message || String(error);
    if (!controller.signal.aborted) throw error;
  } finally {
    abortControllers.delete(descriptor.id);
    for (const temporaryPath of [
      tempDownloadPath,
      tempExtractDir,
      backupInstallDir,
    ]) {
      try {
        fs.rmSync(temporaryPath, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function uninstallToolchain(id: string): Promise<void> {
  const descriptor = TOOLCHAIN_CATALOG.find((entry) => entry.id === id);
  if (!descriptor) {
    throw new Error(`Unknown toolchain package '${id}'.`);
  }
  const installDir = path.join(getToolchainsDir(), id);
  try {
    fs.rmSync(installDir, { recursive: true, force: true });
    const prefs = loadPreferences();
    prefs.installedToolchains = (prefs.installedToolchains || []).filter(
      (item) => item !== id,
    );
    savePreferences(prefs);
    installProgressMap.delete(id);
    try {
      await purgeCachedManagedToolchain(descriptor.kind);
    } catch (cacheError) {
      // The installed package is already gone and compilation now fails
      // closed. Cache cleanup is best-effort so a locked stale file cannot
      // make a successful uninstall appear to have failed.
      console.warn(
        `[Storage] Managed ${descriptor.kind} executor cache cleanup deferred:`,
        cacheError instanceof Error ? cacheError.message : String(cacheError),
      );
    }
  } catch (error: any) {
    console.error(
      `[Storage] Failed to uninstall toolchain ${id}:`,
      error.message,
    );
    throw error;
  }
}
