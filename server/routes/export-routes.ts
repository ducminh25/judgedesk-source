import fs from "fs";
import crypto from "crypto";
import path from "path";
import { raw, type Express } from "express";
import { TEMP_ROOT } from "../runtime.js";
import { openScoreWorkbook } from "../export/workbook-opener.js";
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
      const exportDir = path.join(exportsDir, crypto.randomUUID());
      await fs.promises.mkdir(exportDir, { recursive: true });
      const exportPath = path.join(exportDir, "Book.xlsx");
      const diagnosticsPath = path.join(exportDir, "diagnostics.json");
      await Promise.all([
        fs.promises.writeFile(exportPath, workbook),
        fs.promises.writeFile(diagnosticsPath, diagnosticJson, "utf8"),
      ]);

      const openMode = await openScoreWorkbook(exportPath);
      return res.json({ success: true, path: exportPath, diagnosticsPath, openMode });
    } catch (error: any) {
      const message = error.message || "Failed to open workbook.";
      const status = /payload|Workbook|Diagnostic JSON/.test(message) ? 400 : 500;
      return res.status(status).json({ success: false, message });
    }
  });
}
