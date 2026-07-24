import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import type { Express } from "express";
import { TEMP_ROOT } from "../runtime.js";

export function registerExportRoutes(app: Express): void {
  app.post("/api/open-excel", (req, res) => {
    try {
      const workbookBase64 = req.body?.workbookBase64;
      const diagnosticJson = req.body?.diagnosticJson;
      if (typeof workbookBase64 !== "string" || workbookBase64.length === 0) {
        return res.status(400).json({ success: false, message: "Workbook data is required." });
      }

      const workbook = Buffer.from(workbookBase64, "base64");
      if (workbook.length === 0 || workbook.length > 25 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: "Workbook is empty or too large." });
      }
      if (
        typeof diagnosticJson !== "string"
        || Buffer.byteLength(diagnosticJson, "utf8") === 0
        || Buffer.byteLength(diagnosticJson, "utf8") > 25 * 1024 * 1024
      ) {
        return res.status(400).json({
          success: false,
          message: "Diagnostic JSON is required and must be at most 25 MiB.",
        });
      }
      try {
        JSON.parse(diagnosticJson);
      } catch {
        return res.status(400).json({
          success: false,
          message: "Diagnostic JSON is invalid.",
        });
      }

      const exportsDir = path.join(TEMP_ROOT, "exports");
      fs.mkdirSync(exportsDir, { recursive: true });
      const exportId = Date.now();
      const exportPath = path.join(exportsDir, `judging_result_${exportId}.xlsx`);
      const diagnosticsPath = path.join(
        exportsDir,
        `judging_result_${exportId}.diagnostics.json`,
      );
      fs.writeFileSync(exportPath, workbook);
      fs.writeFileSync(diagnosticsPath, diagnosticJson, "utf8");

      const platform = os.platform();
      const opener =
        platform === "win32"
          ? spawn("explorer.exe", [exportPath], { detached: true, stdio: "ignore" })
          : platform === "darwin"
            ? spawn("open", [exportPath], { detached: true, stdio: "ignore" })
            : spawn("xdg-open", [exportPath], { detached: true, stdio: "ignore" });
      opener.unref();
      return res.json({ success: true, path: exportPath, diagnosticsPath });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message || "Failed to open workbook." });
    }
  });
}
