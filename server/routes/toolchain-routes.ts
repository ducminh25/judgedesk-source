import { Express } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import {
  clearToolchainDetectionCache,
  isPythonCheckerReady,
  isPythonSubmissionReady,
  resolveManagedToolchain,
  resolveToolchain,
} from "../toolchains/resolver.js";
import {
  loadOfficialManifest,
  TOOLCHAIN_CATALOG,
} from "../toolchains/manifest.js";
import {
  getInstallProgress,
  installToolchain,
  cancelInstallation,
  uninstallToolchain,
} from "../toolchains/installer.js";
import {
  getToolchainsDir,
  loadPreferences,
  savePreferences,
} from "../toolchains/storage.js";

export function registerToolchainRoutes(app: Express): void {
  app.post("/api/toolchains/rescan", (_req, res) => {
    clearToolchainDetectionCache();
    res.json({ success: true });
  });

  // GET /api/toolchains
  app.get("/api/toolchains", async (req, res) => {
    const platform = os.platform();
    const arch = os.arch();
    const prefs = loadPreferences();

    const resolvedCpp = resolveToolchain("cpp");
    const resolvedPython = resolveToolchain("python");
    const managedCpp = resolveManagedToolchain("cpp");
    const managedPython = resolveManagedToolchain("python");

    let manifestError: string | undefined;
    const manifest = await loadOfficialManifest().catch((error: Error) => {
      manifestError = error.message;
      return [];
    });
    const toolchainsList = manifest.map((descriptor) => {
      const progress = getInstallProgress(descriptor.id);

      const isInstalled = fs.existsSync(
        path.join(
          getToolchainsDir(),
          descriptor.id,
          descriptor.executableRelativePath,
        ),
      );

      return {
        ...descriptor,
        installed: isInstalled,
        progress: progress || {
          id: descriptor.id,
          status: "idle",
          percent: 0,
          bytesReceived: 0,
          totalBytes: descriptor.sizeBytes || 0,
        },
      };
    });

    res.json({
      platform,
      arch,
      preferences: prefs,
      active: {
        cpp: resolvedCpp,
        python: resolvedPython,
      },
      capabilities: {
        cpp: {
          detected: resolvedCpp.ready,
          managed: managedCpp.ready,
          submissionReady: platform === "win32" ? managedCpp.ready : resolvedCpp.ready,
          checkerReady: platform === "win32" ? managedCpp.ready : resolvedCpp.ready,
          installable: TOOLCHAIN_CATALOG.some(
            (entry) => entry.kind === "cpp" && entry.platform === platform && entry.arch === arch,
          ),
        },
        python: {
          detected: resolvedPython.ready,
          managed: managedPython.ready,
          submissionReady: isPythonSubmissionReady(resolvedPython),
          checkerReady: isPythonCheckerReady(resolvedPython),
          installable: TOOLCHAIN_CATALOG.some(
            (entry) => entry.kind === "python" && entry.platform === platform && entry.arch === arch,
          ),
        },
      },
      toolchains: toolchainsList,
      manifestError,
    });
  });

  // POST /api/toolchains/:id/install
  app.post("/api/toolchains/:id/install", async (req, res) => {
    const { id } = req.params;
    let manifest;
    try {
      manifest = await loadOfficialManifest({ forceRefresh: true });
    } catch (error: any) {
      return res.status(503).json({
        success: false,
        message: error.message || "Toolchain manifest is unavailable.",
      });
    }
    const descriptor = manifest.find((d) => d.id === id);
    if (!descriptor) {
      return res.status(404).json({
        success: false,
        message: `Toolchain descriptor with ID '${id}' not found.`,
      });
    }
    const hostArch =
      os.arch() === "x64" ? "x64" : os.arch() === "arm64" ? "arm64" : os.arch();
    if (descriptor.platform !== os.platform() || descriptor.arch !== hostArch) {
      return res.status(400).json({
        success: false,
        message:
          "This toolchain package is not compatible with the current host.",
      });
    }

    const progress = getInstallProgress(id);
    if (
      progress &&
      (progress.status === "downloading" ||
        progress.status === "extracting" ||
        progress.status === "verifying")
    ) {
      return res.status(400).json({
        success: false,
        message: "Installation is already in progress.",
      });
    }

    // Trigger installation asynchronously
    console.log(`[Toolchains API] Starting async installation of ${id}`);
    installToolchain(descriptor).catch((err) => {
      console.error(
        `[Toolchains API] Async installation of ${id} failed:`,
        err.message,
      );
    });

    res.status(202).json({ success: true, message: "Installation started." });
  });

  // POST /api/toolchains/:id/cancel
  app.post("/api/toolchains/:id/cancel", (req, res) => {
    const { id } = req.params;
    cancelInstallation(id);
    res.json({ success: true, message: "Cancel request received." });
  });

  // DELETE /api/toolchains/:id
  app.delete("/api/toolchains/:id", async (req, res) => {
    const { id } = req.params;
    if (!TOOLCHAIN_CATALOG.some((entry) => entry.id === id)) {
      return res.status(404).json({
        success: false,
        message: `Toolchain descriptor with ID '${id}' not found.`,
      });
    }
    try {
      await uninstallToolchain(id);
      res.json({
        success: true,
        message: `Toolchain '${id}' uninstalled successfully.`,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // POST /api/toolchains/custom-path
  app.post("/api/toolchains/custom-path", (req, res) => {
    const { kind, path: customPath, preferredSource } = req.body;
    if (kind !== "cpp" && kind !== "python") {
      return res.status(400).json({
        success: false,
        message: "Invalid toolchain kind. Must be 'cpp' or 'python'.",
      });
    }
    if (customPath !== undefined && typeof customPath !== "string") {
      return res.status(400).json({
        success: false,
        message: "Custom toolchain path must be a string.",
      });
    }
    if (
      preferredSource !== undefined &&
      !["managed", "custom", "system"].includes(preferredSource)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid preferred toolchain source.",
      });
    }

    const prefs = loadPreferences();
    if (kind === "cpp") {
      if (customPath !== undefined) prefs.customCppPath = customPath;
      if (preferredSource !== undefined)
        prefs.preferredSourceCpp = preferredSource;
    } else {
      if (customPath !== undefined) prefs.customPythonPath = customPath;
      if (preferredSource !== undefined)
        prefs.preferredSourcePython = preferredSource;
    }

    savePreferences(prefs);
    res.json({
      success: true,
      message: "Preferences updated.",
      preferences: prefs,
    });
  });
}
