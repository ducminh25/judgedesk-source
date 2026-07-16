import fs from "fs";
import path from "path";
import type { Express } from "express";
import { naturalSort } from "../file-utils.js";
import {
  readStoredProblemConfig,
  writeStoredProblemConfig
} from "../problems/problem-config-repository.js";

export function registerProblemRoutes(app: Express): void {
  app.get("/api/fetch-contestants", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.json({ success: true, data: [] });
      }
      const dirs = fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);
      return res.json({ success: true, data: dirs });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/fetch-problems", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.json({ success: true, data: [] });
      }
      const dirs = fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);

      const customCheckers: Record<string, string[]> = {};
      for (const dir of dirs) {
        const problemPath = path.join(resolved, dir);
        const executableFiles: string[] = [];
        const cppFiles: string[] = [];
        try {
          for (const file of fs.readdirSync(problemPath)) {
            if (!fs.statSync(path.join(problemPath, file)).isFile()) continue;
            const lowerFile = file.toLowerCase();
            if (lowerFile.endsWith(".exe")) {
              executableFiles.push(file);
            } else if (lowerFile.endsWith(".cpp")) {
              cppFiles.push(file);
            }
          }
        } catch {}
        executableFiles.sort(naturalSort);
        cppFiles.sort(naturalSort);
        customCheckers[dir] = [...executableFiles, ...cppFiles];
      }

      return res.json({ success: true, data: dirs, customCheckers });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/fetch-tests", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, message: "Path required" });
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.json({ success: true, data: [] });
      }
      const dirs = fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);
      return res.json({ success: true, data: dirs });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/fetch-polygon-tests", (req, res) => {
    const dirPath = req.query.path as string;
    const problemName = req.query.problem as string;
    if (!dirPath || !problemName) {
      return res.status(400).json({ success: false, message: "Path and problem name required" });
    }

    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.json({ success: true, data: [] });
      }

      const dirs = fs.readdirSync(resolved).filter((dir) => fs.statSync(path.join(resolved, dir)).isDirectory());
      dirs.sort(naturalSort);

      let configuredInput = "";
      try {
        const storedConfig = readStoredProblemConfig(resolved);
        if (storedConfig) {
          if (!storedConfig.useStdIn && !storedConfig.useStdIO && storedConfig.inputFile) {
            configuredInput = storedConfig.inputFile;
          }
        }
      } catch {}

      const result = dirs.map((dir) => {
        const testDirPath = path.join(resolved, dir);
        const possibleInputs = [
          configuredInput,
          `${problemName}.inp`,
          `${problemName.toLowerCase()}.inp`,
          `${problemName.toUpperCase()}.inp`,
          `${problemName}.in`,
          `${problemName.toLowerCase()}.in`
        ].filter(Boolean);
        const inputPath = possibleInputs
          .map((file) => path.join(testDirPath, file))
          .find((filePath) => fs.existsSync(filePath));

        if (!inputPath) return { name: dir, preview: "", size: 0 };

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
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/polygon-config", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ success: false, message: "Path required" });
    try {
      return res.json({ success: true, data: readStoredProblemConfig(dirPath) });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/polygon-config", (req, res) => {
    const dirPath = req.body.path as string;
    const config = req.body.config;
    if (!dirPath || !config) {
      return res.status(400).json({ success: false, message: "Path and config required" });
    }
    try {
      writeStoredProblemConfig(dirPath, config);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });
}
