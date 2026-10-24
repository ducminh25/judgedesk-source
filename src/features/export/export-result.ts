import type { ScoreExportResult } from "../../../shared/score-export-wire.js";
import type { AppErrorOptions } from "../errors/app-error.js";

type ExportTranslator = (key: string, options: { defaultValue: string; path?: string }) => string;

export function viewerFailureOptions(
  result: ScoreExportResult,
  translate: ExportTranslator,
  copyPath: (path: string) => void,
): AppErrorOptions {
  return {
    code: "EXCEL_VIEWER_FAILED",
    title: translate("appErrors.excelViewerFailed.title", { defaultValue: "Excel file created, but the viewer could not open" }),
    reason: translate("appErrors.excelViewerFailed.reason", { defaultValue: "Your workbook and diagnostics were saved. The spreadsheet application could not be started." }),
    action: translate("appErrors.excelViewerFailed.action", {
      defaultValue: "Open {{path}} in your file manager and save a copy before closing JudgeDesk.", path: result.path,
    }),
    actionLabel: translate("appErrors.excelViewerFailed.copyPath", { defaultValue: "Copy file path" }),
    onAction: () => copyPath(result.path),
    severity: "error",
  };
}
