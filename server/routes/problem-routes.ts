import fs from "fs";
import path from "path";
import type { Express } from "express";
import { naturalSort } from "../file-utils.js";
import {
  readStoredProblemConfig,
  writeStoredProblemConfig
} from "../problems/problem-config-repository.js";
import { listTestDirectories, resolveTestCaseFiles } from "../judge/testcase-discovery.js";

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
      const dirs = fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);

      const customCheckers: Record<string, string[]> = {};
      for (const dir of dirs) {
        const problemPath = path.join(resolved, dir);
        customCheckers[dir] = discoverCustomCheckers(problemPath);
      }

      return res.json({ success: true, data: dirs, customCheckers });
    } catch (error: any) {
      const code = error?.code || "DIRECTORY_ACCESS_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to access problems directory" });
    }
  });

  app.get("/api/fetch-tests", (req, res) => {
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
      const dirs = listTestDirectories(resolved);
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
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ success: false, code: "DIRECTORY_NOT_FOUND", message: "Directory not found" });
      }
      if (!fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ success: false, code: "NOT_A_DIRECTORY", message: "Path is not a directory" });
      }

      const dirs = listTestDirectories(resolved);

      const result = dirs.map((dir) => {
        const testFiles = resolveTestCaseFiles(resolved, dir);
        if (!testFiles) return { name: dir, preview: "", size: 0 };
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
      return res.json({ success: true, data: readStoredProblemConfig(dirPath) });
    } catch (error: any) {
      const code = error?.code || "CONFIG_READ_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to read problem configuration" });
    }
  });

  app.post("/api/polygon-config", (req, res) => {
    const dirPath = req.body.path as string;
    const config = req.body.config;
    if (!dirPath || !config) {
      return res.status(400).json({ success: false, code: "PARAMS_REQUIRED", message: "Path and config required" });
    }
    try {
      writeStoredProblemConfig(dirPath, config);
      return res.json({ success: true });
    } catch (error: any) {
      const code = error?.code || "CONFIG_WRITE_ERROR";
      return res.status(500).json({ success: false, code, message: "Failed to write problem configuration" });
    }
  });
}

export function discoverCustomCheckers(problemPath: string): string[] {
  try {
    return fs.readdirSync(problemPath)
      .filter((file) => {
        const lower = file.toLowerCase();
        return (lower.endsWith(".cpp") || lower.endsWith(".py"))
          && fs.statSync(path.join(problemPath, file)).isFile();
      })
      .sort(naturalSort);
  } catch {
    return [];
  }
}
