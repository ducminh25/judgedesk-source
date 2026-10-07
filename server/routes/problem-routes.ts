import fs from "fs";
import path from "path";
import { validateProblemTestInputs } from "../problems/test-wellformed.js";
import type { Express } from "express";
import { naturalSort } from "../file-utils.js";
import {
  readStoredProblemConfig,
  writeStoredProblemConfig
} from "../problems/problem-config-repository.js";
import {
  discoverTestCases,
  isFlatTestDirectory,
  listTestDirectories,
  resolveProblemDirectoryPath,
} from "../judge/testcase-discovery.js";

export function registerProblemRoutes(app: Express): void {
  app.get("/api/fetch-contestants", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, code: "PATH_REQUIRED", message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ success: false, code: "DIRECTORY_NOT_FOUND", message: "Directory not found" });
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ success: false, code: "NOT_A_DIRECTORY", message: "Path is not a directory" });
      }
      const dirs = fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);
      return res.json({ success: true, data: dirs });
    } catch (error: any) {
      const code = error?.code || "DIRECTORY_ACCESS_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to access contestants directory" });
    }
  });

  app.get("/api/fetch-problems", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, code: "PATH_REQUIRED", message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ success: false, code: "DIRECTORY_NOT_FOUND", message: "Directory not found" });
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ success: false, code: "NOT_A_DIRECTORY", message: "Path is not a directory" });
      }
      const directProblem = isFlatTestDirectory(resolved);
      const dirs = directProblem ? [path.basename(resolved)]
        : fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);

      const customCheckers: Record<string, string[]> = {};
      const interactors: Record<string, string[]> = {};
      for (const dir of dirs) {
        const problemPath = directProblem ? resolved : path.join(resolved, dir);
        customCheckers[dir] = discoverCustomCheckers(problemPath);
        interactors[dir] = discoverInteractors(problemPath);
      }

      return res.json({ success: true, data: dirs, customCheckers, interactors });
    } catch (error: any) {
      const code = error?.code || "DIRECTORY_ACCESS_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to access problems directory" });
    }
  });

  app.get("/api/fetch-tests", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, code: "PATH_REQUIRED", message: "Path required" });
    try {
      const resolved = resolveProblemDirectoryPath(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ success: false, code: "DIRECTORY_NOT_FOUND", message: "Directory not found" });
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ success: false, code: "NOT_A_DIRECTORY", message: "Path is not a directory" });
      }
      const storedConfig = readStoredProblemConfig(resolved);
      const isInteractive = Boolean(storedConfig?.isInteractive || req.query.isInteractive === "true");
      const dirs = listTestDirectories(resolved, isInteractive);
      return res.json({ success: true, data: dirs });
    } catch (error: any) {
      const code = error?.code || "DIRECTORY_ACCESS_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to access test directories" });
    }
  });

  app.get("/api/fetch-polygon-tests", (req, res) => {
    const dirPath = req.query.path as string;
    const problemName = req.query.problem as string;
    if (!dirPath || !problemName) {
      return res.status(400).json({ success: false, code: "PATH_REQUIRED", message: "Path and problem name required" });
    }

    try {
      const resolved = resolveProblemDirectoryPath(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ success: false, code: "DIRECTORY_NOT_FOUND", message: "Directory not found" });
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ success: false, code: "NOT_A_DIRECTORY", message: "Path is not a directory" });
      }

      const storedConfig = readStoredProblemConfig(resolved);
      const isInteractive = Boolean(storedConfig?.isInteractive || req.query.isInteractive === "true");
      const tests = discoverTestCases(resolved, isInteractive);

      const result = tests.map((testFiles) => {
        const dir = testFiles.name;
        const inputPath = testFiles.inputPath;

        const size = fs.statSync(inputPath).size;
        if (size === 0) return { name: dir, preview: "", size };

        const fd = fs.openSync(inputPath, "r");
        const buffer = Buffer.alloc(35);
        const bytesRead = fs.readSync(fd, buffer, 0, 35, 0);
        fs.closeSync(fd);
        let preview = buffer.toString("utf8", 0, bytesRead).replace(/\r/g, "");
        if (size > 35) preview += "...";
        return { name: dir, preview, size };
      });

      return res.json({ success: true, data: result });
    } catch (error: any) {
      const code = error?.code || "DIRECTORY_ACCESS_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to access testcases" });
    }
  });

  app.get("/api/polygon-config", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, code: "PATH_REQUIRED", message: "Path required" });
    try {
      const resolved = resolveProblemDirectoryPath(dirPath);
      return res.json({ success: true, data: readStoredProblemConfig(resolved) });
    } catch (error: any) {
      const code = error?.code || "CONFIG_READ_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to read problem configuration" });
    }
  });

  app.post("/api/polygon-config", async (req, res) => {
    const dirPath = req.body?.path as string;
    const config = req.body?.config;
    if (typeof dirPath !== "string" || !dirPath || !config || typeof config !== "object" || Array.isArray(config)) {
      return res.status(400).json({ success: false, code: "PARAMS_REQUIRED", message: "Path and config required" });
    }
    if (req.body?.validateOnly === true && config.testWellFormed !== true) {
      return res.status(400).json({ success: false, code: "VALIDATION_REQUIRED", message: "Enable well-formed validation for a preview" });
    }
    try {
      const resolved = resolveProblemDirectoryPath(dirPath);
      if (config.testWellFormed === true) {
        const validation = await validateProblemTestInputs(resolved, config.isInteractive === true);
        if (req.body?.validateOnly === true) return res.json({ success: true, data: validation });
        if (validation.issues.length > 0) {
          return res.status(422).json({ success: false, code: "TEST_NOT_WELL_FORMED", message: "Test inputs are not well-formed", data: validation });
        }
      }
      writeStoredProblemConfig(resolved, config);
      return res.json({ success: true });
    } catch (error: any) {
      const code = error?.code || "CONFIG_WRITE_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to write problem configuration" });
    }
  });
}

export function discoverCustomCheckers(
  problemPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  try {
    const isWindows = platform === "win32";
    const files = fs.readdirSync(problemPath).filter((file) => {
      const lower = file.toLowerCase();
      const isCandidate = lower.endsWith(".cpp")
        || lower.endsWith(".py")
        || (isWindows && lower.endsWith(".exe"));
      if (!isCandidate) return false;
      try {
        return fs.statSync(path.join(problemPath, file)).isFile();
      } catch {
        return false;
      }
    });

    const getExtensionPriority = (fileName: string): number => {
      const lower = fileName.toLowerCase();
      if (lower.endsWith(".exe")) return 0;
      if (lower.endsWith(".cpp")) return 1;
      if (lower.endsWith(".py")) return 2;
      return 3;
    };

    return files.sort((a, b) => {
      const prioA = getExtensionPriority(a);
      const prioB = getExtensionPriority(b);
      if (prioA !== prioB) return prioA - prioB;
      return naturalSort(a, b);
    });
  } catch {
    return [];
  }
}

export function discoverInteractors(
  problemPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  try {
    const isWindows = platform === "win32";
    const files = fs.readdirSync(problemPath).filter((file) => {
      const lower = file.toLowerCase();
      const isCandidate = lower.startsWith("interactor") && (
        lower.endsWith(".cpp")
        || lower.endsWith(".py")
        || (isWindows && lower.endsWith(".exe"))
      );
      if (!isCandidate) return false;
      try {
        return fs.statSync(path.join(problemPath, file)).isFile();
      } catch {
        return false;
      }
    });

    const getExtensionPriority = (fileName: string): number => {
      const lower = fileName.toLowerCase();
      if (lower.endsWith(".exe")) return 0;
      if (lower.endsWith(".cpp")) return 1;
      if (lower.endsWith(".py")) return 2;
      return 3;
    };

    return files.sort((a, b) => {
      const prioA = getExtensionPriority(a);
      const prioB = getExtensionPriority(b);
      if (prioA !== prioB) return prioA - prioB;
      return naturalSort(a, b);
    });
  } catch {
    return [];
  }
}
