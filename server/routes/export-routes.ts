import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { raw, type Express } from "express";
import { TEMP_ROOT } from "../runtime.js";
import {
  decodeScoreExportPayload,
  MAX_SCORE_EXPORT_PAYLOAD_BYTES,
  SCORE_EXPORT_CONTENT_TYPE,
} from "../../shared/score-export-wire.js";

export function registerExportRoutes(app: Express): void {
  app.post("/api/open-excel", raw({
    type: SCORE_EXPORT_CONTENT_TYPE,
    limit: MAX_SCORE_EXPORT_PAYLOAD_BYTES,
  }), async (req, res) => {
    try {
      const body = req.body;
      if (!(body instanceof Uint8Array)) {
        return res.status(400).json({ success: false, message: "Score export payload is required." });
      }
      const { workbook, diagnosticJson } = decodeScoreExportPayload(body);

      const exportsDir = path.join(TEMP_ROOT, "exports");
      await fs.promises.mkdir(exportsDir, { recursive: true });
      const exportId = Date.now();
      const exportPath = path.join(exportsDir, `judging_result_${exportId}.xlsx`);
      const diagnosticsPath = path.join(
        exportsDir,
        `judging_result_${exportId}.diagnostics.json`,
      );
      await Promise.all([
        fs.promises.writeFile(exportPath, workbook),
        fs.promises.writeFile(diagnosticsPath, diagnosticJson, "utf8"),
      ]);

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
      const message = error.message || "Failed to open workbook.";
      const status = /payload|Workbook|Diagnostic JSON/.test(message) ? 400 : 500;
      return res.status(status).json({ success: false, message });
    }
  });
}
