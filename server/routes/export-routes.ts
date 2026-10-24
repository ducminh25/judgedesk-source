import fs from "fs";
import crypto from "crypto";
import path from "path";
import { raw, type Express } from "express";
import { TEMP_ROOT } from "../runtime.js";
import { openScoreWorkbook, type WorkbookOpenMode } from "../export/workbook-opener.js";
import {
  decodeScoreExportPayload,
  MAX_SCORE_EXPORT_PAYLOAD_BYTES,
  SCORE_EXPORT_CONTENT_TYPE,
} from "../../shared/score-export-wire.js";

export type WorkbookOpenerFn = (workbookPath: string) => Promise<WorkbookOpenMode>;

export function registerExportRoutes(
  app: Express,
  workbookOpener: WorkbookOpenerFn = openScoreWorkbook,
): void {
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
        fs.promises.writeFile(`${exportPath}.tmp`, workbook, { flag: "wx" }),
        fs.promises.writeFile(`${diagnosticsPath}.tmp`, diagnosticJson, { encoding: "utf8", flag: "wx" }),
      ]);
      await Promise.all([
        fs.promises.rename(`${exportPath}.tmp`, exportPath),
        fs.promises.rename(`${diagnosticsPath}.tmp`, diagnosticsPath),
      ]);

      let openMode: WorkbookOpenMode | null = null;
      let openError: string | null = null;
      try {
        openMode = await workbookOpener(exportPath);
      } catch (error: unknown) {
        openError = (error instanceof Error ? error.message : String(error)) || "Workbook viewer could not be started";
      }
      return res.json({ success: true, saved: true, path: exportPath, diagnosticsPath, openMode,
        openStatus: openError === null ? "launched" : "failed", openError });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /payload|Workbook|Diagnostic JSON/.test(message) ? 400 : 500;
      return res.status(status).json({ success: false, message });
    }
  });
}
